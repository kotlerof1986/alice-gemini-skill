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

// Быстрый поиск Serper с ограничением ожидания 1.5 секунды
async function quickSearch(query: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

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
    if (data.answerBox?.snippet) parts.push(data.answerBox.snippet);
    if (Array.isArray(data.organic) && data.organic[0]?.snippet) {
      parts.push(data.organic[0].snippet);
    }
    return parts.join(' ');
  } catch {
    clearTimeout(timeoutId);
    return '';
  }
}

// Прямой быстрый вызов Gemini с ограничением ожидания 2.8 секунды
async function callGemini(contents: any[], apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2800);

  // Используем легковесную и самую быструю модель 1.5-flash-8b или 1.5-flash
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: 100,
          temperature: 0.6,
        },
        systemInstruction: {
          parts: [{ text: 'Ты голосовой ассистент Алиса. Отвечай очень кратко (1-2 предложения), без списков и markdown.' }],
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      // Запасная попытка со стандартным gemini-1.5-flash
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const fallbackRes = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 100 } }),
      });
      if (!fallbackRes.ok) return 'Не удалось получить быстрый ответ.';
      const fallbackData = await fallbackRes.json();
      return fallbackData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch {
    clearTimeout(timeoutId);
    return 'Извините, ответ занял слишком много времени.';
  }
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
      response: { text: 'Ключ GEMINI_API_KEY не настроен в Vercel.', end_session: false },
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
      ? `Вопрос: "${userText}". Данные: "${searchData}". Ответь в 1 предложение.`
      : userText;

    const contents = [
      ...history,
      { role: 'user', parts: [{ text: promptText }] },
    ];

    const rawAnswer = await callGemini(contents, geminiKey);
    const cleanAnswer = rawAnswer.replace(/[*#_`\[\]()]/g, '').trim() || 'Ответ не сформирован.';

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
  } catch {
    return res.status(200).json({
      response: { text: 'Сервер временно не отвечает. Попробуйте еще раз.', end_session: false },
      session_state: { history },
      version,
    });
  }
}
