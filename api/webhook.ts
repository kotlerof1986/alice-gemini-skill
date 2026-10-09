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

// Получаем точный список моделей вашего аккаунта
async function findAvailableModel(apiKey: string): Promise<string> {
  const versions = ['v1beta', 'v1'];
  for (const ver of versions) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${apiKey}`);
      if (res.ok) {
        const data = await res.json();
        const models: Array<{ name: string; supportedGenerationMethods?: string[] }> = data.models || [];
        const valid = models.find(m => m.supportedGenerationMethods?.includes('generateContent'));
        if (valid) {
          return `${ver}/${valid.name}`;
        }
      }
    } catch {}
  }
  return 'v1beta/models/gemini-1.5-flash';
}

async function searchSerper(query: string): Promise<string> {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return '';
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 3 }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const parts: string[] = [];
    if (data.answerBox?.answer) parts.push(data.answerBox.answer);
    if (data.organic && Array.isArray(data.organic)) {
      data.organic.slice(0, 3).forEach((item: any) => {
        if (item.snippet) parts.push(item.snippet);
      });
    }
    return parts.join(' ');
  } catch {
    return '';
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

  const history = (body.state?.session?.history || []).slice(-6);
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(200).json({
      response: { text: 'GEMINI_API_KEY не задан в Vercel.', end_session: false },
      session_state: { history },
      version,
    });
  }

  try {
    const needsSearch = /(новост|курс|погод|сегодня|сейчас|кто победил|доллар|евро)/i.test(userText);
    let searchContext = '';
    if (needsSearch) {
      searchContext = await searchSerper(userText);
    }

    const promptText = searchContext
      ? `Пользователь спросил: "${userText}". Сведения из сети: "${searchContext}". Ответь кратко.`
      : userText;

    const contents = [...history, { role: 'user', parts: [{ text: promptText }] }];

    // Находим работающую модель конкретно для вашего ключа
    const modelTarget = await findAvailableModel(geminiKey);
    const url = `https://generativelanguage.googleapis.com/${modelTarget}:generateContent?key=${geminiKey}`;

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: 'Ты голосовой ассистент Алиса. Отвечай кратко, емко, без звездочек и markdown (1-2 предложения).' }],
        },
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(200).json({
        response: { text: `Ошибка модели (${modelTarget}):${errText.slice(0, 100)}`, end_session: false },
        session_state: { history },
        version,
      });
    }

    const data = await apiRes.json();
    const rawAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Не удалось сформировать ответ.';
    const cleanAnswer = rawAnswer.replace(/[*#_`\[\]()]/g, '').trim();

    return res.status(200).json({
      response: { text: cleanAnswer, end_session: false },
      session_state: {
        history: [...history, { role: 'user', parts: [{ text: userText }] }, { role: 'model', parts: [{ text: cleanAnswer }] }].slice(-6),
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
