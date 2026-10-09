import type { VercelRequest, VercelResponse } from '@vercel/node';

interface MessageHistory {
  role: 'user' | 'model';
  parts: [{ text: string }];
}

interface AliceRequest {
  request?: { command?: string; original_utterance?: string };
  session?: { new?: boolean };
  state?: { session?: { history?: MessageHistory[] } };
  version: string;
}

async function quickSearch(query: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200);

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 2 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return '';
    const data = await res.json();
    const parts: string[] = [];
    if (data.answerBox?.answer) parts.push(data.answerBox.answer);
    if (data.organic && data.organic[0]?.snippet) parts.push(data.organic[0].snippet);
    return parts.join(' ');
  } catch {
    clearTimeout(timeoutId);
    return '';
  }
}

async function callGemini(contents: any[], apiKey: string): Promise<string> {
  // Список рабочих моделей для проверки в v1beta
  const model = 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.5,
      },
      systemInstruction: {
        parts: [{ text: 'Ты голосовой ассистент Алиса. Отвечай коротко (1-2 предложения), без списков и звездочек.' }],
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return `Статус ${res.status}:${errorText.slice(0, 160)}`;
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Пустой ответ модели.';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).send('Alice webhook active');

  const body = (req.body || {}) as AliceRequest;
  const version = body.version || '1.0';
  const isNew = body.session?.new ?? false;
  const userText = (body.request?.command || body.request?.original_utterance || '').trim();

  if (isNew || !userText) {
    return res.status(200).json({
      response: {
        text: 'Здравствуйте! Я готова помочь. О чём хотите узнать?',
        end_session: false,
      },
      session_state: { history: [] },
      version,
    });
  }

  const history = (body.state?.session?.history || []).slice(-4);
  const geminiKey = process.env.GEMINI_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;

  if (!geminiKey) {
    return res.status(200).json({
      response: { text: 'Ключ GEMINI_API_KEY не задан в Vercel.', end_session: false },
      session_state: { history },
      version,
    });
  }

  try {
    let searchData = '';
    const needsSearch = /(новости|курс|погода|сегодня|сейчас|доллар|евро)/i.test(userText);

    if (needsSearch && serperKey) {
      searchData = await quickSearch(userText, serperKey);
    }

    const promptText = searchData
      ? `Вопрос: "${userText}". Справка из поиска: "${searchData}". Ответь кратко.`
      : userText;

    const contents = [
      ...history,
      { role: 'user', parts: [{ text: promptText }] },
    ];

    const rawAnswer = await callGemini(contents, geminiKey);
    const cleanAnswer = rawAnswer.replace(/[*#_`\[\]()]/g, '').trim();

    return res.status(200).json({
      response: {
        text: cleanAnswer,
        end_session: false,
      },
      session_state: {
        history: [
          ...history,
          { role: 'user', parts: [{ text: userText }] },
          { role: 'model', parts: [{ text: cleanAnswer }] },
        ].slice(-4),
      },
      version,
    });
  } catch (err: any) {
    return res.status(200).json({
      response: { text: `Ошибка: ${String(err?.message || err).slice(0, 100)}`, end_session: false },
      session_state: { history },
      version,
    });
  }
}
