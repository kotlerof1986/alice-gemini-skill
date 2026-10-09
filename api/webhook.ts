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

// Быстрый поиск в Serper с ограничением ожидания 1.5 сек
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).send('Alice webhook active');

  const body = (req.body || {}) as AliceRequest;
  const version = body.version || '1.0';
  const isNew = body.session?.new ?? false;
  const userText = (body.request?.command || body.request?.original_utterance || '').trim();

  // Приветственное сообщение в начале новой сессии
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

  // Восстановление истории из состояния сессии (до 4 реплик для скорости)
  const history = (body.state?.session?.history || []).slice(-4);
  const geminiKey = process.env.GEMINI_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;

  if (!geminiKey) {
    return res.status(200).json({
      response: { text: 'В Vercel не настроен GEMINI_API_KEY.', end_session: false },
      session_state: { history },
      version,
    });
  }

  try {
    let searchData = '';
    const needsSearch = /(новост|курс|погод|сегодня|сейчас|кто победил|доллар|евро|счет)/i.test(userText);

    if (needsSearch && serperKey) {
      searchData = await quickSearch(userText, serperKey);
    }

    const promptText = searchData
      ? `Пользователь спросил: "${userText}". Справка из поиска: "${searchData}". Ответь кратко на вопрос.`
      : userText;

    const contents = [
      ...history,
      { role: 'user', parts: [{ text: promptText }] },
    ];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: 'Ты голосовой ассистент Яндекс Алиса. Отвечай кратко, емко, без звездочек и markdown (1-2 простых предложения).' }],
        },
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 150,
        },
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(200).json({
        response: { text: `Ошибка Gemini (${apiRes.status}):${errText.slice(0, 100)}`, end_session: false },
        session_state: { history },
        version,
      });
    }

    const data = await apiRes.json();
    const rawAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Не удалось сформировать ответ.';
    const cleanAnswer = rawAnswer.replace(/[*#_`\[\]()]/g, '').trim();

    const updatedHistory: MessageHistory = [
      ...history,
      { role: 'user', parts: [{ text: userText }] },
      { role: 'model', parts: [{ text: cleanAnswer }] },
    ].slice(-4);

    return res.status(200).json({
      response: {
        text: cleanAnswer,
        end_session: false,
      },
      session_state: { history: updatedHistory },
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
