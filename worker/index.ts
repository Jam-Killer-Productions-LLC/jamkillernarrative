/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import type { Context } from 'hono';

// Define the environment interface used by both the front-end routes and the Durable Object.
interface Env {
  NARRATIVE_DO: DurableObjectNamespace;
  AI: {
    run: (
      model: string,
      options: { messages: Array<{ role: string; content: string }> }
    ) => Promise<{ choices: Array<{ message: { content: string } }> }>;
  };
  RATE_LIMIT_KV: KVNamespace;
}

/**
 * Durable Object Class for Narrative State
 * This class handles updating the narrative (adding answers) and finalizing it.
 */
export class NarrativeDO {
  state: DurableObjectState;
  narrativeState: {
    answers: string[];
    createdAt: number;
    lastUpdated: number;
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    // Initialize with an empty state.
    this.narrativeState = { answers: [], createdAt: Date.now(), lastUpdated: Date.now() };
    // Ensure we load any existing state before processing any requests.
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<any>('narrativeState');
      if (stored) {
        this.narrativeState = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Route for updating narrative state: /update
      if (request.method === 'POST' && path.startsWith('/update')) {
        // Parse JSON with a type hint so TS knows there is an "answer" property.
        const { answer } = await request.json<{ answer: string }>();
        if (!answer || typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 1000) {
          return new Response(JSON.stringify({ error: 'Invalid answer provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (this.narrativeState.answers.length >= 20) {
          return new Response(JSON.stringify({ error: 'Maximum number of answers reached' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const sanitizedAnswer = answer.trim();
        this.narrativeState.answers.push(sanitizedAnswer);
        this.narrativeState.lastUpdated = Date.now();
        await this.state.storage.put('narrativeState', this.narrativeState);
        return new Response(
          JSON.stringify({ message: 'Answer added successfully', answerCount: this.narrativeState.answers.length }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Route for finalizing the narrative: /finalize
      else if (request.method === 'POST' && path.startsWith('/finalize')) {
        if (this.narrativeState.answers.length < 1) {
          return new Response(JSON.stringify({ error: 'Insufficient answers to finalize narrative' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const promptContent = this.narrativeState.answers.join('\n');
        const systemMessage = `You are a narrative storyteller for "Don't Kill The Jam, a Jam Killer Story." 
The user provided these answers:
${promptContent}
Generate a creative, detailed narrative that captures their dystopian music journey.`.replace(/<\/?[^>]+(>|$)/g, '');
        const userMessage = "Provide a final narrative text with rich imagery and emotional depth.";
        const messages = [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ];
        // Call the AI service. (If it fails, fall back to a simple narrative.)
        const aiResponse = await (async () => {
          try {
            return await (globalThis as any).env.AI.run('@cf/meta/llama-3-8b-instruct', { messages });
          } catch (error) {
            console.error('AI call failed:', error);
            return { choices: [{ message: { content: `Final Narrative: ${promptContent}` } }] };
          }
        })();
        const finalNarrativeText = aiResponse.choices[0].message.content;
        const totalAnswerLength = this.narrativeState.answers.reduce((sum, ans) => sum + ans.length, 0);
        const averageAnswerLength = totalAnswerLength / this.narrativeState.answers.length;
        const answerCountFactor = Math.min(this.narrativeState.answers.length / 10, 1);
        const mojoScore = Math.min(Math.floor(averageAnswerLength * 10 + answerCountFactor * 20), 100);
        const finalNarrativeData = {
          narrativeText: finalNarrativeText,
          mojoScore,
          timestamp: Date.now(),
          metadata: {
            answerCount: this.narrativeState.answers.length,
            processingTime: 0,
          },
        };
        await this.state.storage.put('finalNarrative', finalNarrativeData);
        return new Response(
          JSON.stringify({ message: 'Narrative finalized successfully', data: finalNarrativeData }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (error) {
      console.error('DO error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}

/**
 * Front-end Worker Code (Routing using Hono)
 * This part of the code receives public HTTP requests and routes them
 * to the appropriate Durable Object instance based on the userId.
 */
const app = new Hono<{ Bindings: Env }>();

// Common middleware: logging, pretty JSON, CORS, and security headers.
app.use('*', logger());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: ['*'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);
app.options('*', (c) =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  })
);
app.use('*', async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'none'; style-src 'none';");
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  await next();
});

// Health check route.
app.get('/', (c) => c.json({ status: 'ok', message: 'Narrative API is running (Durable Object version)' }));

// Route to update narrative. This forwards the request to the Durable Object.
app.post('/narrative/update/:userId', async (c) => {
  const userId = c.req.param('userId');
  if (!userId || typeof userId !== 'string' || userId.length > 100) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const id = c.env.NARRATIVE_DO.idFromName(userId);
  const stub = c.env.NARRATIVE_DO.get(id);
  // Use c.req.raw to access the native Request's headers and body.
  const response = await stub.fetch(`https://dummy/update`, {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  });
  return response;
});

// Route to finalize narrative.
app.post('/narrative/finalize/:userId', async (c) => {
  const userId = c.req.param('userId');
  if (!userId || typeof userId !== 'string' || userId.length > 100) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const id = c.env.NARRATIVE_DO.idFromName(userId);
  const stub = c.env.NARRATIVE_DO.get(id);
  const response = await stub.fetch(`https://dummy/finalize`, {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  });
  return response;
});

export default app;