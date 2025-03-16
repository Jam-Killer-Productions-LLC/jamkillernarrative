// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { KVNamespace } from '@cloudflare/workers-types';
import { z } from 'zod';

// Type definitions for narrative state and final metadata
interface NarrativeState {
  choices: string[];
  createdAt: number;
}

interface FinalMetadata {
  narrativeText: string;
  artUrl: string;
  mojoScore: number;
  ipfsUrl: string;
  timestamp: number;
}

// Environment interface (bindings and environment variables)
interface Env {
  // KV namespace binding using your provided namespace name
  narrativesjamkiller: KVNamespace;
  // IPFS upload endpoint provided via QuickNode
  IPFS_UPLOAD_URL: string;
  // IPFS API key provided by QuickNode
  IPFS_API_KEY: string;
}

// Create a Hono app instance
const app = new Hono<{ Bindings: Env }>();

// Apply CORS and security headers
app.use('*', cors());
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'self'");
  await next();
});

// Rate limiting middleware
const rateLimit = {
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per windowMs
};

app.use('/narrative/update/*', async (c, next) => {
  const key = c.req.ip;
  const limiter = new Map();

  if (limiter.has(key)) {
    const [count, reset] = limiter.get(key);
    if (count >= rateLimit.max) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    limiter.set(key, [count + 1, reset]);
  } else {
    limiter.set(key, [1, Date.now() + rateLimit.windowMs]);
  }
  await next();
});

/**
 * POST /narrative/update/:userId
 * Appends a new choice to the user's narrative state stored in the KV namespace "narrativesjamkiller".
 */
app.post('/narrative/update/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const { choice } = await c.req.json<{ choice: string }>();
    
    // Validate input
    if (!choice || typeof choice !== 'string' || choice.length > 500) {
      return c.json({ error: 'Invalid choice provided' }, 400);
    }

    // Sanitize input
    const sanitizedChoice = choice.trim();

    // Retrieve existing narrative state from KV
    const existingData = await c.env.narrativesjamkiller.get(userId);
    let state: NarrativeState;
    if (existingData) {
      state = JSON.parse(existingData);
      if (state.choices.length >= 10) { // Max 10 choices
        return c.json({ error: 'Maximum number of choices reached' }, 400);
      }
      state.choices.push(sanitizedChoice);
    } else {
      state = { choices: [sanitizedChoice], createdAt: Date.now() };
    }
    
    // Update narrative state in KV
    await c.env.narrativesjamkiller.put(userId, JSON.stringify(state));
    
    return c.json({ 
      message: 'Narrative updated successfully',
      state
    });
  } catch (error) {
    console.error('Error updating narrative:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /narrative/finalize/:userId
 * Finalizes the narrative: composes final narrative text and prompt,
 * computes a mojo score, internally calls the artistic worker to generate art,
 * uploads the metadata to IPFS, and returns the final metadata.
 */
app.post('/narrative/finalize/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    
    // Retrieve existing narrative state
    const stored = await c.env.narrativesjamkiller.get(userId);
    if (!stored) {
      return c.json({ error: 'No narrative state found for this user' }, 404);
    }
    const state: NarrativeState = JSON.parse(stored);

    if (state.choices.length < 1) {
      return c.json({ error: 'Insufficient choices to finalize narrative' }, 400);
    }

    // Compose final narrative text
    const narrativeText = `Your journey: ${state.choices.join(' -> ')}`;
    
    // Generate a final prompt for art generation
    const finalPrompt = `Create an image that represents: ${narrativeText}`;
    
    // Compute mojo score
    const mojoScore = state.choices.length * 10 + (Date.now() % 100);

    // Internal call to artistic worker endpoint
    const artisticWorkerUrl = 'https://artisticjammer.fletcher-christians-account3359.workers.dev/generate';
    const artResponse = await fetch(artisticWorkerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: finalPrompt }),
    });
    
    if (!artResponse.ok) {
      console.error('Artistic worker call failed');
      return c.json({ error: 'Failed to generate art' }, 500);
    }
    const artData = await artResponse.json<{ artUrl: string }>();
    const artUrl = artData.artUrl;

    // Combine final metadata
    const finalMetadata: FinalMetadata = {
      narrativeText,
      artUrl,
      mojoScore,
      ipfsUrl: '', // To be updated after IPFS upload
      timestamp: Date.now(),
    };

    // Upload final metadata to IPFS via QuickNode
    const ipfsResponse = await fetch(c.env.IPFS_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.IPFS_API_KEY}`
      },
      body: JSON.stringify(finalMetadata),
    });
    
    if (!ipfsResponse.ok) {
      console.error('IPFS upload failed');
      return c.json({ error: 'Failed to upload metadata to IPFS' }, 500);
    }
    const ipfsData = await ipfsResponse.json() as { ipfsUrl: string };
    finalMetadata.ipfsUrl = ipfsData.ipfsUrl;

    // Remove the user's narrative state from KV
    await c.env.narrativesjamkiller.delete(userId);

    // Return final metadata
    return c.json({ 
      message: 'Narrative finalized successfully',
      metadata: finalMetadata
    });
  } catch (error) {
    console.error('Error finalizing narrative:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
