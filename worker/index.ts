/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Type definitions for narrative state and final narrative data
interface NarrativeState {
  answers: string[];
  createdAt: number;
}

interface FinalNarrativeData {
  narrativeText: string;
  mojoScore: number;
  timestamp: number;
}

// Environment interface: includes KV and AI binding
interface Env {
  narrativesjamkiller: KVNamespace;
  AI: {
    run: (
      model: string,
      options: { messages: Array<{ role: string; content: string }> }
    ) => Promise<{ choices: Array<{ message: { content: string } }> }>;
  };
  RATE_LIMIT_KV: KVNamespace;
}

// Create a Hono app instance
const app = new Hono<{ Bindings: Env }>();

// Apply CORS and security headers
app.use('*', cors());
app.use('*', async (c: Hono.Context<Env>, next: () => Promise<void>) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'self'");
  await next();
});

// Configure rate limiting
const rateLimit = {
  windowMs: 60 * 1000, // 1 minute window
  max: 10,              // 10 requests per IP per window
};

// Helper function to get IP address
const getIpAddress = (request: Request): string => {
  return request.headers.get('cf-connecting-ip') || 'unknown';
};

// Rate limiting middleware using KV storage
app.use('/narrative/update/*', async (c: Hono.Context<Env>, next: () => Promise<void>) => {
  const ip = getIpAddress(c.req);
  const now = Date.now();
  
  // Get current count and window end from KV
  const current = await c.env.RATE_LIMIT_KV.get(ip);
  if (current) {
    const { count, windowEnd } = JSON.parse(current);
    
    // Check if we're in the same window
    if (now < windowEnd) {
      if (count >= rateLimit.max) {
        return c.json({ error: 'Too many requests' }, 429);
      }
      // Increment count
      await c.env.RATE_LIMIT_KV.put(ip, JSON.stringify({
        count: count + 1,
        windowEnd
      }));
    } else {
      // Reset window
      await c.env.RATE_LIMIT_KV.put(ip, JSON.stringify({
        count: 1,
        windowEnd: now + rateLimit.windowMs
      }));
    }
  } else {
    // First request in window
    await c.env.RATE_LIMIT_KV.put(ip, JSON.stringify({
      count: 1,
      windowEnd: now + rateLimit.windowMs
    }));
  }
  
  await next();
});

/**
 * POST /narrative/update/:userId
 * Appends a new answer to the user's narrative state stored in KV.
 */
app.post('/narrative/update/:userId', async (c: Hono.Context<Env>) => {
  try {
    const userId = c.req.param('userId');
    if (!userId || typeof userId !== 'string' || userId.length > 100) {
      return c.json({ error: 'Invalid user ID' }, 400);
    }

    const { answer } = await c.req.json<{ answer: string }>();
    
    if (!answer || typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 1000) {
      return c.json({ error: 'Invalid answer provided' }, 400);
    }
    const sanitizedAnswer = answer.trim();

    const existingData = await c.env.narrativesjamkiller.get(userId);
    let state: NarrativeState;
    
    if (existingData) {
      state = JSON.parse(existingData);
      if (state.answers.length >= 20) {
        return c.json({ error: 'Maximum number of answers reached' }, 400);
      }
      state.answers.push(sanitizedAnswer);
    } else {
      state = { 
        answers: [sanitizedAnswer], 
        createdAt: Date.now()
      };
    }
    
    await c.env.narrativesjamkiller.put(userId, JSON.stringify(state));
    return c.json({ 
      message: 'Answer added successfully',
      data: {
        answerCount: state.answers.length
      }
    });
  } catch (error) {
    console.error('Error updating narrative state:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /narrative/finalize/:userId
 * Finalizes the narrative and generates the final story
 */
app.post('/narrative/finalize/:userId', async (c: Hono.Context<Env>) => {
  try {
    const userId = c.req.param('userId');
    if (!userId || typeof userId !== 'string' || userId.length > 100) {
      return c.json({ error: 'Invalid user ID' }, 400);
    }

    const stored = await c.env.narrativesjamkiller.get(userId);
    if (!stored) {
      return c.json({ error: 'No narrative state found for this user' }, 404);
    }
    
    const state: NarrativeState = JSON.parse(stored);
    if (state.answers.length < 1) {
      return c.json({ error: 'Insufficient answers to finalize narrative' }, 400);
    }

    // Sanitize and prepare prompt content
    const promptContent = state.answers.join('\n');
    
    // Sanitize messages to prevent injection
    const systemMessage = `You are a narrative storyteller for "Don't Kill The Jam, a Jam Killer Story." 
    The user provided these answers:\n${promptContent}\nGenerate a creative, detailed narrative that captures 
    their dystopian music journey.`.replace(/<\/?[^>]+(>|$)/g, '');
    
    const userMessage = "Provide a final narrative text with rich imagery and emotional depth.";
    
    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ];

    const aiResponse = await c.env.AI.run("@cf/meta/llama-3-8b-instruct", { messages });
    const finalNarrativeText = aiResponse.choices[0].message.content;

    // Improved Mojo score calculation
    const totalAnswerLength = state.answers.reduce((sum, ans) => sum + ans.length, 0);
    const averageAnswerLength = totalAnswerLength / state.answers.length;
    const mojoScore = Math.min(Math.floor(averageAnswerLength * 10), 100);

    const finalNarrativeData: FinalNarrativeData = {
      narrativeText: finalNarrativeText,
      mojoScore,
      timestamp: Date.now()
    };

    // Delete the state after finalization
    await c.env.narrativesjamkiller.delete(userId);
    
    return c.json({ 
      message: 'Narrative finalized successfully',
      data: finalNarrativeData
    });
  } catch (error) {
    console.error('Error finalizing narrative:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
