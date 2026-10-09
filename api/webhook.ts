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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(200).send('Alice webhook active');
  }

  const body = (req.body || {}) as AliceRequest;
  const version = body.version || '1.0';
  const isNew = body.session?.new ?? false;
  const userText = (body.request?.command || body.request?.original_utterance || '').trim();

  // Приветствие при старте сессии
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

  // Проверка наличия ключа
  if (!geminiKey) {
    return res.status(200).json({
      response: {
        text: 'Ошибка: переменная GEMINI_API_KEY не найдена в Vercel. Добавьте её в настройках и сделайте Redeploy.',
        end_session: false,
      },
      session_state: { history },
      version,
    });
  }

  try {
    const contents = [
      ...history,
      {
        role: 'user',
        parts: [{ text: userText }],
      },
    ];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: 'Отвечай кратко, емко, без markdown-разметки и звездочек (1-2 предложения).' }],
        },
      }),
    });

    if (!apiResponse.ok) {
      const errBody = await apiResponse.text();
      return res.status(200).json({
        response: {
          text: `Google API вернул ошибку ${apiResponse.status}:${errBody.slice(0, 150)}`,
          end_session: false,
        },
        session_state: { history },
        version,
      });
    }

    const data = await apiResponse.json();
    const modelText =
      data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/[*#_`\[\]()]/g, '').trim() ||
      'Не удалось получить ответ.';

    const updatedHistory: MessageHistory[] = [
      ...history,
      { role: 'user', parts: [{ text: userText }] },
      { role: 'model', parts: [{ text: modelText }] },
    ].slice(-6);

    return res.status(200).json({
      response: {
        text: modelText,
        end_session: false,
      },
      session_state: { history: updatedHistory },
      version,
    });
  } catch (e: any) {
    return res.status(200).json({
      response: {
        text: `Исключение на сервере: ${String(e?.message || e)}`,
        end_session: false,
      },
      session_state: { history },
      version,
    });
  }
}
