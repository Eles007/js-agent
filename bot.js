import { Telegraf, Markup } from "telegraf";
import fs from "fs";
import path from "path";
import XLSX from "xlsx";
import axios from "axios";
import {
  TELEGRAM_TOKEN,
  YANDEX_OAUTH_TOKEN,
  YANDEX_FOLDER_ID,
  EMPLOYEE_CHAT_ID,
} from "./config.js";

const REQUIRED_FIELDS = [
  "name",
  "phone",
  "productType", // печать или штамп
  "usage", // для кого
  "textOnStamp",
  "size",
  "language",
  "logo",
  "color",
  "osnastkaCategory",
  "osnastkaModel",
  "quantity",
  "urgency",
];

// Шаблоны для красивого вывода итогов:
const FIELD_LABELS = {
  name: "Как вас зовут?",
  phone: "Ваш номер телефона?",
  productType: "Что нужно — печать или штамп?",
  usage: "Для кого будет использоваться?",
  textOnStamp: "Что должно быть написано?",
  size: "Размер изделия?",
  language: "Язык текста?",
  logo: "Добавить логотип или изображение?",
  color: "Цвет оттиска?",
  osnastkaCategory: "Категория оснастки?",
  osnastkaModel: "Модель оснастки?",
  quantity: "Количество штук?",
  urgency: "Срочность, доставка, пожелания?",
};

let iamToken = null;
let iamTokenExpire = 0;

async function getIamToken() {
  const url = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
  const headers = { "Content-Type": "application/json" };
  const data = { yandexPassportOauthToken: YANDEX_OAUTH_TOKEN };

  const res = await axios.post(url, data, { headers });
  iamToken = res.data.iamToken;
  iamTokenExpire = Date.parse(res.data.expiresAt) - 60000;
  console.log("🔑 Получен новый IAM токен");
}

async function ensureIamToken() {
  if (!iamToken || Date.now() > iamTokenExpire) {
    await getIamToken();
  }
}

// Отправка текста пользователя в GPT для выделения полей (JSON) и динамического вопроса, если надо
async function analyzeUserText(userText, knownData = {}) {
  await ensureIamToken();

  const url = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${iamToken}`,
  };

  // Промпт для GPT — выделить поля заказа в JSON и указать, чего не хватает, задать вопрос если надо
  const prompt = `
Пользователь написал заказ на печать/штамп:

"${userText}"

Извлеки из этого текста JSON с такими полями (если есть):

- name: имя заказчика
- phone: номер телефона
- productType: "печать" или "штамп"
- usage: для кого (например, ИП, ООО)
- textOnStamp: что должно быть написано
- size: размер (например, диаметр 40мм)
- language: язык текста (русский, английский, оба)
- logo: добавить логотип или нет (да/нет)
- color: цвет оттиска
- osnastkaCategory: категория оснастки (автоматическая, ручная, карманная)
- osnastkaModel: модель оснастки (например, "Офис", "Тродант")
- quantity: количество штук
- urgency: срочность, доставка, пожелания

Если каких-то полей не хватает, дай короткий уточняющий вопрос, чтобы получить эти данные.

Ответь строго в формате JSON с двумя полями:
{
  "data": { ... }, // заполненные поля
  "question": "..." // уточняющий вопрос или пустая строка, если всё есть
}

Пример:

{
  "data": {
    "name": "Иван Иванов",
    "phone": "+79991234567",
    "productType": "печать"
  },
  "question": "Для кого будет использоваться печать?"
}
`;

  const data = {
    modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt-lite`,
    completionOptions: {
      stream: false,
      temperature: 0,
      maxTokens: 500,
    },
    messages: [{ role: "user", text: prompt }],
  };

  const res = await axios.post(url, data, { headers });
  const raw = res.data.result.alternatives[0].message.text.trim();

  try {
    // Пробуем распарсить JSON из ответа GPT
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}") + 1;
    const jsonString = raw.substring(jsonStart, jsonEnd);
    const parsed = JSON.parse(jsonString);
    return parsed;
  } catch (e) {
    console.error("Ошибка парсинга JSON от GPT:", e);
    return {
      data: {},
      question: "Не смог понять ваш заказ, пожалуйста, опишите подробнее.",
    };
  }
}

// Функция сохранения в Excel
function saveToExcel(answers) {
  const filePath = "./orders.xlsx";
  let data = [];

  if (fs.existsSync(filePath)) {
    const workbook = XLSX.readFile(filePath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  } else {
    data.push(Object.values(FIELD_LABELS));
  }

  const row = REQUIRED_FIELDS.map((f) => answers[f] || "");
  data.push(row);

  const worksheet = XLSX.utils.aoa_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Заказы");
  XLSX.writeFile(workbook, filePath);

  return filePath;
}

const bot = new Telegraf(TELEGRAM_TOKEN);
const sessions = new Map();

bot.start((ctx) => {
  sessions.set(ctx.chat.id, {
    data: {}, // данные заказа
    awaitingQuestion: "", // вопрос, который нужно задать пользователю
  });
  ctx.reply(
    "Привет! Расскажите, пожалуйста, что именно вам нужно для заказа печати или штампа. Можно в свободной форме."
  );
});

bot.on("message", async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) {
    return ctx.reply("Введите /start для начала оформления заказа.");
  }

  const userText = ctx.message.text.trim();

  // Отправляем весь собранный текст + текущий ответ на уточняющий вопрос (если был)
  let textForGPT = userText;
  if (session.awaitingQuestion) {
    textForGPT = session.awaitingQuestion + " " + userText;
  }

  const { data, question } = await analyzeUserText(textForGPT, session.data);

  // Обновляем данные в сессии
  session.data = { ...session.data, ...data };

  if (question && question.length > 0) {
    session.awaitingQuestion = question;
    return ctx.reply(question);
  } else {
    // Все данные собраны — показываем итог и сохраняем

    let summary = "Вот что вы указали:\n\n";
    for (const field of REQUIRED_FIELDS) {
      if (session.data[field]) {
        summary += `${FIELD_LABELS[field]} ${session.data[field]}\n`;
      }
    }

    ctx.reply(summary);
    saveToExcel(session.data);

    // Отправляем сотруднику краткий заказ
    let shortSummary = "Новый заказ:\n";
    for (const field of REQUIRED_FIELDS) {
      if (session.data[field]) {
        shortSummary += `${FIELD_LABELS[field]} ${session.data[field]} | `;
      }
    }
    shortSummary = shortSummary.slice(0, -3);

    await ctx.telegram.sendMessage(EMPLOYEE_CHAT_ID, shortSummary);

    // Завершаем сессию
    sessions.delete(ctx.chat.id);
  }
});

bot.launch();
console.log("🤖 Бот запущен и готов к работе!");
