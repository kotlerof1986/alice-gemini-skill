import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(200).json({
      response: { text: 'Ключ GEMINI_API_KEY не найден в Vercel.', end_session: false },
      version: '1.0',
    });
  }

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
    const data = await listRes.json();

    if (!listRes.ok) {
      return res.status(200).json({
        response: { text: `Ошибка списка: ${JSON.stringify(data).slice(0, 150)}`, end_session: false },
        version: '1.0',
      });
    }

    const availableNames = (data.models || [])
      .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m: any) => m.name.replace('models/', ''))
      .slice(0, 5)
      .join(', ');

    return res.status(200).json({
      response: {
        text: `Доступные модели: ${availableNames || 'список пуст'}`,
        end_session: false,
      },
      version: '1.0',
    });
  } catch (err: any) {
    return res.status(200).json({
      response: { text: `Ошибка запроса: ${String(err?.message || err)}`, end_session: false },
      version: '1.0',
    });
  }
}
