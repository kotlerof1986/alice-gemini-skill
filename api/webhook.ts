import type { VercelRequest, VercelResponse } from '@vercel/node';

interface MessageHistory {
  role: 'user' | 'model';
  parts: [{ text: string }];
}

interface AliceRequest {
  request?: {
    command?: string;
    original_utterance?: string;
  };
  session?: {
    new?: boolean;
  };
  state?: {
    session?: {
      history?: MessageHistory[];
    };
  };
  version: string;
}

// Запрос к Serper для свежих данных
async function searchWeb(query: string): Promise<string> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return '';

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 3 }),
    });

    if (!res.ok) return '';
    const data = await res.json();
    const parts: string[] = [];

    if (data.answerBox?.answer) parts.push(data.answerBox.answer);
    if (data.answerBox?.snippet) parts.push(data.answerBox.snippet);
    if (Array.isArray(data.organic)) {
      data.organic.slice(0, 3).forEach((item: any) => {
        if (item.snippet) parts.push(item.snippet);
      });
    }

    return parts.join(' ');
  } catch {
    return '';
  }
}

// Запрос к Gemini 1.5 Flash через стандартный REST API
async function askGemini(history: MessageHistory[], prompt: string, searchContext = ''): Promise<string> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return 'В настройках сервера не указан ключ GEMINI_API_KEY.';

  const systemPrompt =
    'Ты голосовой помощник Алиса. Отвечай кратко, емко и по сути (1-3 простых предложения). Не используй markdown-разметку, списки, ссылки и звездочки.';

  const fullPrompt = searchContext
    ? `Вопрос пользователя: "${prompt}"\n\nАктуальные данные из поиска: "${searchContext}"\nСформулируй краткий ответ на основе этих данных.`
    : prompt;

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{ text: fullPrompt }],
    },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 200,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return `Ошибка Google API (${res.status}):${errText.slice(0, 120)}`;
  }

  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    'Не удалось получить ответ.'
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Обработка проверки доступности (GET)
  if (req.method !== 'POST') {
    return res.status(200).send('Alice webhook active');
  }

  const body = (req.body || {}) as AliceRequest;
  const version = body.version || '1.0';
  const isNew = body.session?.new ?? false;
  const userText = (body.request?.command || body.request?.original_utterance || '').trim();

  // Начало диалога
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

  try {
    // Если вопрос требует свежих фактов (новости, курсы, погода) — делаем быстрый поиск
    const needsSearch = /(новост|курс|погод|сегодня|сейчас|кто победил|счет|доллар|евро)/i.test(userText);
    let searchData = '';

    if (needsSearch) {
      searchData = await searchWeb(userText);
    }

    let answer = await askGemini(history, userText, searchData);

    // Удаляем markdown-символы для чистого голоса
    answer = answer.replace(/[*#_`\[\]()]/g, '').trim();

    const updatedHistory: MessageHistory[] = [
      ...history,
      { role: 'user', parts: [{ text: userText }] },
      { role: 'model', parts: [{ text: answer }] },
    ].slice(-6);

    return res.status(200).json({
      response: {
        text: answer,
        end_session: false,
      },
      session_state: {
        history: updatedHistory,
      },
      version,
    });
  } catch (error: any) {
    return res.status(200).json({
      response: {
        text: `Ошибка сервера: ${String(error?.message || error).slice(0, 100)}`,
        end_session: false,
      },
      session_state: { history },
      version,
    });
  }
}
