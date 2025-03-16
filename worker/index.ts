/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Type definitions for narrative state and final narrative data
interface NarrativeState {
  answers: string[]; // Answers provided by the user
  createdAt: number;
}

interface FinalNarrativeData {
  narrativeText: string;
  mojoScore: number;
  timestamp: number;
  // This is not the final NFT metadata—it's the narrative data used to build NFT metadata later.
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

// In-memory rate limiting (ephemeral per instance)
const limiter = new Map<string, [number, number]>();
const rateLimit = {
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 requests per IP per window
};

app.use('/narrative/update/*', async (c: Hono.Context<Env>, next: () => Promise<void>) => {
  const key = c.req.ip;
  if (limiter.has(key)) {
    const [count, reset] = limiter.get(key)!;
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
 * Appends a new answer to the user's narrative state stored in the KV namespace "narrativesjamkiller".
 */
app.post('/narrative/update/:userId', async (c: Hono.Context<Env>) => {
  try {
    const userId = c.req.param('userId');
    const { answer } = await c.req.json<{ answer: string }>();

    // Validate input: answer must be non-empty and within a reasonable length.
    if (!answer || typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 1000) {
      return c.json({ error: 'Invalid answer provided' }, 400);
    }
    const sanitizedAnswer = answer.trim();

    // Retrieve existing narrative state from KV.
    const existingData = await c.env.narrativesjamkiller.get(userId);
    let state: NarrativeState;
    if (existingData) {
      state = JSON.parse(existingData);
      if (state.answers.length >= 20) {
        return c.json({ error: 'Maximum number of answers reached' }, 400);
      }
      state.answers.push(sanitizedAnswer);
    } else {
      state = { answers: [sanitizedAnswer], createdAt: Date.now() };
    }
    // Save updated state to KV.
    await c.env.narrativesjamkiller.put(userId, JSON.stringify(state));
    return c.json({ message: 'Answer added successfully', state });
  } catch (error) {
    console.error('Error updating narrative state:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /narrative/finalize/:userId
 * Finalizes the narrative:
 * - Retrieves stored answers,
 * - Builds a prompt and calls the AI to generate the final narrative,
 * - Computes a Mojo score based on the total length of answers,
 * - Returns the final narrative data to the front end.
 */
app.post('/narrative/finalize/:userId', async (c: Hono.Context<Env>) => {
  try {
    const userId = c.req.param('userId');
    const stored = await c.env.narrativesjamkiller.get(userId);
    if (!stored) {
      return c.json({ error: 'No narrative state found for this user' }, 404);
    }
    const state: NarrativeState = JSON.parse(stored);
    if (state.answers.length < 1) {
      return c.json({ error: 'Insufficient answers to finalize narrative' }, 400);
    }

    // Build a prompt from the collected answers.
    const promptContent = state.answers.join('\n');
    const systemMessage = `You are a narrative storyteller for "Don't Kill The Jam, a Jam Killer Story." The user has chosen a path and provided the following answers:\n${promptContent}\nUsing this context, generate a creative and detailed narrative that reflects their journey in a dystopian music world.`;
    const userMessage = "Provide a final narrative text with rich imagery and emotional depth.";
    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ];

    // Call the AI to generate the final narrative.
    const aiResponse = await c.env.AI.run("@cf/meta/llama-3-8b-instruct", { messages });
    const finalNarrativeText = aiResponse.choices[0].message.content;

    // Compute Mojo score based on the total length of user answers.
    const totalAnswerLength = state.answers.reduce((sum, ans) => sum + ans.length, 0);
    const mojoScore = totalAnswerLength; // Adjust this formula as needed.

    const finalNarrativeData: FinalNarrativeData = {
      narrativeText: finalNarrativeText,
      mojoScore,
      timestamp: Date.now()
    };

    // Optionally, remove the narrative state from KV.
    await c.env.narrativesjamkiller.delete(userId);

    // Return the final narrative data.
    return c.json({ message: 'Narrative finalized successfully', data: finalNarrativeData });
  } catch (error) {
    console.error('Error finalizing narrative:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;