/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import type { Context } from 'hono';

// Type definitions for narrative state and final narrative data
interface NarrativeState {
  answers: string[];
  createdAt: number;
  lastUpdated: number;
}

interface FinalNarrativeData {
  narrativeText: string;
  mojoScore: number;
  timestamp: number;
  metadata: {
    answerCount: number;
    processingTime: number;
  };
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

// Apply middleware: logging, pretty JSON output, and CORS
app.use('*', logger());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: ['*'],
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length', 'X-Request-ID'],
    maxAge: 86400,
  })
);

// Explicit OPTIONS route handling (in addition to CORS middleware)
// This ensures that any preflight requests receive a 204 response with the appropriate headers.
app.options('*', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
});

// Security headers middleware
app.use('*', async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'none'; style-src 'none';");
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  await next();
});

// Root route handler
app.get('/', (c) => c.json({ status: 'ok', message: 'Narrative API is running' }));

// Configure rate limiting settings
const rateLimit = {
  windowMs: 60 * 1000, // 1 minute window
  max: 10,             // 10 requests per IP per window
};

// Helper function to extract IP address from request headers
const getIpAddress = (request: Request): string => {
  const headers = request.headers;
  return headers.get('cf-connecting-ip') ||
         headers.get('x-forwarded-for')?.split(',')[0] ||
         'unknown';
};

// Rate limiting middleware using KV storage for the /narrative/update/* endpoints
app.use('/narrative/update/*', async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
  const ip = getIpAddress(c.req.raw);
  const now = Date.now();
  
  try {
    // Get current count and window end from KV
    const current = await c.env.RATE_LIMIT_KV.get(ip);
    if (current) {
      const { count, windowEnd } = JSON.parse(current);
      
      // Check if we're still in the current rate limit window
      if (now < windowEnd) {
        if (count >= rateLimit.max) {
          return c.json({ 
            error: 'Too many requests',
            retryAfter: Math.ceil((windowEnd - now) / 1000)
          }, 429);
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
      // First request in the window
      await c.env.RATE_LIMIT_KV.put(ip, JSON.stringify({
        count: 1,
        windowEnd: now + rateLimit.windowMs
      }));
    }
    
    await next();
  } catch (error) {
    console.error('Rate limiting error:', error);
    // Fail open on rate limiting errors
    await next();
  }
});

/**
 * POST /narrative/update/:userId
 * Appends a new answer to the user's narrative state stored in KV.
 */
app.post('/narrative/update/:userId', async (c: Context<{ Bindings: Env }>) => {
  const startTime = Date.now();
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

    // Log the KV namespace to verify it exists
    console.log('KV Namespace:', c.env.narrativesjamkiller);

    // Try to get existing narrative state for the user
    const existingData = await c.env.narrativesjamkiller.get(userId);
    console.log('Existing data:', existingData);

    let state: NarrativeState;
    
    if (existingData) {
      try {
        state = JSON.parse(existingData);
        if (state.answers.length >= 20) {
          return c.json({ error: 'Maximum number of answers reached' }, 400);
        }
        state.answers.push(sanitizedAnswer);
        state.lastUpdated = Date.now();
      } catch (parseError) {
        console.error('Error parsing existing data:', parseError);
        // If parsing fails, start fresh
        state = { 
          answers: [sanitizedAnswer], 
          createdAt: Date.now(),
          lastUpdated: Date.now()
        };
      }
    } else {
      state = { 
        answers: [sanitizedAnswer], 
        createdAt: Date.now(),
        lastUpdated: Date.now()
      };
    }
    
    // Log the state we're about to save
    console.log('Saving state:', state);
    
    // Save the updated narrative state to KV
    try {
      await c.env.narrativesjamkiller.put(userId, JSON.stringify(state));
      console.log('Successfully saved to KV');
    } catch (kvError) {
      console.error('Error saving to KV:', kvError);
      return c.json({ error: 'Failed to save narrative state' }, 500);
    }

    return c.json({ 
      message: 'Answer added successfully',
      data: {
        answerCount: state.answers.length,
        processingTime: Date.now() - startTime
      }
    });
  } catch (error) {
    console.error('Error updating narrative state:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /narrative/finalize/:userId
 * Finalizes the narrative and generates the final story.
 */
app.post('/narrative/finalize/:userId', async (c: Context<{ Bindings: Env }>) => {
  const startTime = Date.now();
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

    // Prepare the prompt content using stored answers
    const promptContent = state.answers.join('\n');
    
    // Sanitize and prepare messages to prevent injection
    const systemMessage = `You are a narrative storyteller for "Don't Kill The Jam, a Jam Killer Story." 
The user provided these answers:
${promptContent}
Generate a creative, detailed narrative that captures their dystopian music journey.`.replace(/<\/?[^>]+(>|$)/g, '');
    
    const userMessage = "Provide a final narrative text with rich imagery and emotional depth.";
    
    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ];

    // Call the AI binding to generate the final narrative
    const aiResponse = await c.env.AI.run("@cf/meta/llama-3-8b-instruct", { messages });
    const finalNarrativeText = aiResponse.choices[0].message.content;

    // Calculate an improved Mojo score
    const totalAnswerLength = state.answers.reduce((sum, ans) => sum + ans.length, 0);
    const averageAnswerLength = totalAnswerLength / state.answers.length;
    const answerCountFactor = Math.min(state.answers.length / 10, 1);
    const mojoScore = Math.min(Math.floor((averageAnswerLength * 10 + answerCountFactor * 20)), 100);

    const finalNarrativeData: FinalNarrativeData = {
      narrativeText: finalNarrativeText,
      mojoScore,
      timestamp: Date.now(),
      metadata: {
        answerCount: state.answers.length,
        processingTime: Date.now() - startTime
      }
    };

    // Save the final narrative instead of deleting the state
    const finalKey = `${userId}_final`;
    await c.env.narrativesjamkiller.put(finalKey, JSON.stringify(finalNarrativeData));
    
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