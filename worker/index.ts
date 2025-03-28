/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import type { Context } from 'hono';

/**
 * Environment interface shared by both the front-end routes and the Durable Object.
 */
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
 * Durable Object class for managing narrative state.
 */
export class NarrativeDO {
  state: DurableObjectState;
  env: Env;
  narrativeState: { answers: string[]; createdAt: number; lastUpdated: number };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.narrativeState = { answers: [], createdAt: Date.now(), lastUpdated: Date.now() };
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<any>('narrativeState');
      if (stored) {
        this.narrativeState = stored;
        console.log('Loaded stored state:', this.narrativeState);
      } else {
        console.log('No stored state found. Starting fresh.');
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Define allowed origins for CORS
    const allowedOrigins = [
      'https://mojohand.producerprotocol.pro',
      'https://ajamkillerstory.pages.dev',
      'https://producerprotocol.pro',
      'https://narratives.producerprotocol.pro',
    ];
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    };

    try {
      // Handle OPTIONS (CORS preflight)
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (request.method === 'POST' && path.startsWith('/update')) {
        const rawBody = await request.clone().text();
        console.log('DO /update raw body:', rawBody);

        let payload;
        try {
          payload = await request.json();
          console.log('DO /update parsed payload:', payload);
        } catch (e) {
          console.error('Failed to parse JSON payload:', e);
          return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const { answer } = payload as { answer: string };

        // Handle CLEAR_NARRATIVE command
        if (answer === "CLEAR_NARRATIVE") {
          console.log('Clearing narrative data...');
          this.narrativeState = { answers: [], createdAt: Date.now(), lastUpdated: Date.now() };
          await this.state.storage.put('narrativeState', this.narrativeState);
          await this.state.storage.delete('finalNarrative'); // Also clear any finalized narrative
          return new Response(
            JSON.stringify({ message: 'Narrative data cleared successfully' }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        // Regular answer validation
        if (
          !answer ||
          typeof answer !== 'string' ||
          answer.trim().length === 0 ||
          answer.length > 1000
        ) {
          return new Response(JSON.stringify({ error: 'Invalid answer provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        if (this.narrativeState.answers.length >= 20) {
          return new Response(JSON.stringify({ error: 'Maximum number of answers reached' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const sanitizedAnswer = answer.trim();
        console.log('DO state before update:', this.narrativeState);
        this.narrativeState.answers.push(sanitizedAnswer);
        this.narrativeState.lastUpdated = Date.now();
        await this.state.storage.put('narrativeState', this.narrativeState);
        console.log('DO state after update:', this.narrativeState);

        return new Response(
          JSON.stringify({
            message: 'Answer added successfully',
            answerCount: this.narrativeState.answers.length,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      } else if (request.method === 'POST' && path.startsWith('/finalize')) {
        console.log('DO /finalize request received.');

        // Require at least one answer
        if (this.narrativeState.answers.length < 1) {
          return new Response(
            JSON.stringify({ error: 'Insufficient answers to finalize narrative' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        // Build system prompt
        const promptContent = this.narrativeState.answers.join('\n');
        const systemMessage = `You are a narrative storyteller for "Don't Kill The Jam, a Jam Killer Story." 
The user provided these answers:
${promptContent}
Generate a creative, detailed narrative that captures their dystopian music journey.`.replace(
          /<\/?[^>]+(>|$)/g,
          ''
        );

        // The user's request to finalize
        const userMessage = 'Provide a final narrative text with rich imagery and emotional depth.';
        const messages = [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ];

        // Attempt the AI call; fallback if it throws
        const aiResponse = await (async () => {
          try {
            const res = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', { messages });
            console.log('Raw AI response:', JSON.stringify(res));
            return res;
          } catch (error) {
            console.error('AI call failed:', error);
            // Fallback if the AI call throws an exception
            return { choices: [{ message: { content: `Final Narrative: ${promptContent}` } }] };
          }
        })();

        // Safely parse final narrative text
        let finalNarrativeText: string;
        if (
          aiResponse &&
          Array.isArray(aiResponse.choices) &&
          aiResponse.choices.length > 0 &&
          aiResponse.choices[0].message &&
          typeof aiResponse.choices[0].message.content === 'string'
        ) {
          finalNarrativeText = aiResponse.choices[0].message.content;
        } else {
          console.error('AI response did not contain expected structure:', aiResponse);
          finalNarrativeText = `Final Narrative (fallback): ${promptContent}`;
        }

        // Compute a "mojoScore"
        const totalAnswerLength = this.narrativeState.answers.reduce(
          (sum, ans) => sum + ans.length,
          0
        );
        const averageAnswerLength = totalAnswerLength / this.narrativeState.answers.length;
        const answerCountFactor = Math.min(this.narrativeState.answers.length / 10, 1);
        const mojoScore = Math.min(
          Math.floor(averageAnswerLength * 10 + answerCountFactor * 20),
          100
        );

        // Store the final narrative
        const finalNarrativeData = {
          narrativeText: finalNarrativeText,
          mojoScore,
          timestamp: Date.now(),
          metadata: {
            answerCount: this.narrativeState.answers.length,
            processingTime: 0, // optional to measure
          },
        };
        await this.state.storage.put('finalNarrative', finalNarrativeData);
        console.log('DO finalized narrative:', finalNarrativeData);

        // Return success
        return new Response(
          JSON.stringify({ message: 'Narrative finalized successfully', data: finalNarrativeData }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      } else {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    } catch (error) {
      console.error('DO error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  }
}

/**
 * Front-end Routing Worker using Hono.
 */
const app = new Hono<{ Bindings: Env }>();

// Apply middleware
app.use('*', logger());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: [
      'https://mojohand.producerprotocol.pro',
      'https://ajamkillerstory.pages.dev',
      'https://producerprotocol.pro',
      'https://narratives.producerprotocol.pro',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    maxAge: 86400,
  })
);

// Security headers
app.use('*', async (c: Context<{ Bindings: Env }>, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' https://narratives.producerprotocol.pro https://mojohand.producerprotocol.pro https://producerprotocol.pro https://c.thirdweb.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
  );
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  await next();
});

// Health check
app.get('/', (c) =>
  c.json({ status: 'ok', message: 'Narrative API (Durable Object version) is running' })
);

// Update narrative
app.post('/narrative/update/:userId', async (c) => {
  const userId = c.req.param('userId');
  if (!userId || userId.length > 100) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const id = c.env.NARRATIVE_DO.idFromName(userId);
  const stub = c.env.NARRATIVE_DO.get(id);
  const bodyText = await c.req.text();
  console.log(`Routing /narrative/update/${userId} with body:`, bodyText);
  return await stub.fetch('https://narrative-do/update', {
    method: 'POST',
    headers: c.req.raw.headers,
    body: bodyText,
  });
});

// Finalize narrative
app.post('/narrative/finalize/:userId', async (c) => {
  const userId = c.req.param('userId');
  if (!userId || userId.length > 100) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const id = c.env.NARRATIVE_DO.idFromName(userId);
  const stub = c.env.NARRATIVE_DO.get(id);
  const bodyText = await c.req.text();
  console.log(`Routing /narrative/finalize/${userId} with body:`, bodyText);
  return await stub.fetch('https://narrative-do/finalize', {
    method: 'POST',
    headers: c.req.raw.headers,
    body: bodyText,
  });
});

// Favicon handler
const FAVICON_URL =
  'https://bafybeig6dpytw3q4v7vzdy6sb7q4x3apqgrvfi3zsbvb3n6wvs5unfr36i.ipfs.dweb.link?filename=480.gif';
app.get('/favicon.ico', async () => {
  try {
    const response = await fetch(FAVICON_URL);
    if (!response.ok) throw new Error('Failed to fetch favicon');
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error) {
    return new Response(null, { status: 204 });
  }
});

export default {
  fetch: app.fetch,
  DurableObject: NarrativeDO,
};