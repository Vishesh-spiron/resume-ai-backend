// src/controllers/aiController.js
// ─────────────────────────────────────────────────────────────────────────────
// Proxy between Flutter and Groq API.
//
// WHY THIS EXISTS:
//   GROQ_API_KEY must never be in Flutter's bundled .env — anyone can read
//   files from a web app's asset bundle. Keeping the key on Render means it
//   never leaves the server.
//
// Flutter sends:  POST /api/ai/chat  { prompt, model, maxTokens }
// We call:        Groq API (server-side, key from process.env)
// We return:      { success, content }  or  { success, error, status }
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Allowed models — whitelist prevents client from using arbitrary models
const ALLOWED_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
]);

async function chatCompletion(req, res) {
  const { requestId } = req;
  const {
    prompt,
    model      = 'llama-3.3-70b-versatile',
    maxTokens  = 1024,
  } = req.body ?? {};

  // ── Validate request ───────────────────────────────────────────────────────
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Missing or too-short prompt.' });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ success: false, error: `Model "${model}" not allowed.` });
  }
  const tokens = Math.min(Math.max(Number(maxTokens) || 1024, 64), 8192);

  // ── Call Groq ──────────────────────────────────────────────────────────────
  debugLog(requestId, `→ Groq | model=${model} tokens=${tokens} prompt_len=${prompt.length}`);

  let groqRes;
  try {
    groqRes = await fetch(GROQ_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.10,
        max_tokens:  tokens,
        top_p:       0.90,
        stream:      false,
      }),
      signal: AbortSignal.timeout(90_000), // 90 s — long prompts need time
    });
  } catch (err) {
    console.error(`[${requestId}] ❌ Groq network error: ${err.message}`);
    return res.status(502).json({
      success: false,
      error:   'AI service unreachable. Please try again.',
    });
  }

  // ── Handle Groq response ───────────────────────────────────────────────────
  const body = await groqRes.text();

  if (!groqRes.ok) {
    console.error(`[${requestId}] ❌ Groq ${groqRes.status}: ${body.slice(0, 200)}`);
    const clientMsg = groqErrorMessage(groqRes.status);
    return res.status(groqRes.status === 429 ? 429 : 502).json({
      success: false,
      error:   clientMsg,
      status:  groqRes.status,
    });
  }

  let content;
  try {
    const data = JSON.parse(body);
    content = data?.choices?.[0]?.message?.content;
  } catch (_) {
    console.error(`[${requestId}] ❌ Groq response parse failed`);
    return res.status(502).json({ success: false, error: 'Invalid response from AI service.' });
  }

  if (!content || content.trim().length === 0) {
    return res.status(502).json({ success: false, error: 'Empty response from AI service.' });
  }

  debugLog(requestId, `✅ Groq ok | response_len=${content.length}`);
  return res.json({ success: true, content });
}

// Human-readable messages for Groq error codes
function groqErrorMessage(status) {
  switch (status) {
    case 400: return 'Invalid request. Please try again with a different file.';
    case 401: return 'AI service authentication error. Contact support.';
    case 413: return 'Resume text is too long. Try a shorter or cleaner PDF.';
    case 429: return 'AI rate limit reached. Please wait a moment and try again.';
    case 503: return 'AI service temporarily unavailable. Please try again shortly.';
    default:  return `AI service error (${status}). Please try again.`;
  }
}

function debugLog(requestId, msg) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${requestId}] [AI] ${msg}`);
  } else {
    // In production, only log errors — prompts may contain PII
    console.log(`[${requestId}] [AI] ${msg.split('|')[0].trim()}`);
  }
}

module.exports = { chatCompletion };
