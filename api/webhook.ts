import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

interface ChatHistoryItem {
  role: 'user' | 'model';
  parts: [{ text: string }];
}

interface AliceRequest {
  request?: { command?: string };
  session?: { new?: boolean };
  state?: { session?: { history?: ChatHistoryItem[] } };
  version: string;
}

async function runSerperSearch(query: string): Promise<string> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return 'Поиск недоступен: нет SERPER_API_KEY.';

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 3 }),
    });
    if (!res.ok) return 'Ошибка поиска.';
    const data = await res.json();
    const snippets: string[] = [];
    if (data.answerBox?.answer) snippets.push(data.answerBox.answer);
    if (data.organic && Array.isArray(data.organic)) {
      data.organic.slice(0, 3).forEach((item: any) => snippets.push(`${item.title}:${item.snippet}`));
    }
    return snippets.join('\n') || 'Ничего не найдено.';
  } catch {
    return 'Ошибка при поиске.';
  }
}

const searchTool: FunctionDeclaration = {
  name: 'serper_search',
  description: 'Поиск актуальной информации в интернете (новости, курсы, погода, факты).',
  parameters: {
    type: Type.OBJECT,
    properties: { query: { type: Type.STRING, description: 'Поисковый запрос' } },
    required: ['query'],
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).send('Alice webhook active');

  const body = req.body as AliceRequest;
  const version = body?.version || '1.0';
  const isNew = body?.session?.new ?? false;
  const text = body?.request?.command?.trim() || '';

  if (isNew || !text) {
    return res.status(200).json({
      response: { text: 'Здравствуйте! Я готова помочь. О чём хотите узнать?', end_session: false },
      session_state: { history: [] },
      version,
    });
  }

  const history = (body?.state?.session?.history || []).slice(-6);
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(200).json({
      response: { text: 'В Vercel не задан GEMINI_API_KEY.', end_session: false },
      session_state: { history },
      version,
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const contents = [...history, { role: 'user' as const, parts: [{ text }] }];
    const systemInstruction = 'Ты голосовой помощник Алиса. Отвечай кратко (1-3 простых предложения), без звездочек, списков и markdown. Для свежих данных используй serper_search.';

    const initial = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: { systemInstruction, tools: [{ functionDeclarations: [searchTool] }] },
    });

    const call = initial.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall;
    let answer = '';

    if (call) {
      const searchRes = await runSerperSearch((call.args as any).query);
      const second = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          ...contents,
          initial.candidates![0].content,
          { role: 'user' as const, parts: [{ functionResponse: { name: call.name, response: { result: searchRes } } }] },
        ],
        config: { systemInstruction },
      });
      answer = second.text || 'Не удалось найти ответ.';
    } else {
      answer = initial.text || 'Не удалось сформировать ответ.';
    }

    const cleanAnswer = answer.replace(/[*#_`\[\]()]/g, '').trim();

    return res.status(200).json({
      response: { text: cleanAnswer, end_session: false },
      session_state: {
        history: [...history, { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: cleanAnswer }] }].slice(-6),
      },
      version,
    });
  } catch {
    return res.status(200).json({
      response: { text: 'Произошла ошибка при ответе.', end_session: false },
      session_state: { history },
      version,
    });
  }
}
