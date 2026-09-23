import SystemSettings from '../models/SystemSettings.js';
import { funnelDefaults } from '../config/funnelDefaults.js';
import InteractiveMenu from '../models/InteractiveMenu.js';
import InteractiveButton from '../models/InteractiveButton.js';
import { Op } from 'sequelize';

// Cache Map: "userId:settingKey" -> parsedValue
const cache = new Map();

export const defaultSettingsMeta = {
    // الرسائل
    welcome_message: {
        type: 'text',
        category: 'messages',
        label: 'رسالة الترحيب',
        defaultValue: funnelDefaults.welcome_message || `أهلاً بك في أكاديمية GAC لتعليم اللغة الإنجليزية! 🇬🇧✨\n\nيسعدنا معرفة: ما هو سبب رغبتك في تعلم اللغة الإنجليزية؟ 🤔\n\n1️⃣ السفر والعمل بالخارج ✈️\n2️⃣ السياحة والترفيه 🌍\n3️⃣ العمل في كول سنتر 🎧\n4️⃣ الدراسة والتعليم 📚`
    },
    first_followup_message: {
        type: 'text',
        category: 'messages',
        label: 'رسالة المتابعة الأولى',
        defaultValue: `أهلاً بك! حابين نطمن عليك وعلى خطتك للبدء بكورس اللغة الإنجليزية. هل واجهت أي مشكلة أثناء التسجيل أو الدفع؟ 🤔`
    },
    first_followup_type: {
        type: 'text',
        category: 'messages',
        label: 'نوع المتابعة الأولى (static/dynamic)',
        defaultValue: 'static'
    },
    final_followup_message: {
        type: 'text',
        category: 'messages',
        label: 'رسالة المتابعة النهائية + عرض الخصم',
        defaultValue: `يسعدنا أن نقدم لك خصماً خاصاً بنسبة [DISCOUNT]% لفترة محدودة جداً للاشتراك بالكورس! شارك معنا برأيك أو استفسارك وسنساعدك فوراً. 🎁✨`
    },
    final_followup_type: {
        type: 'text',
        category: 'messages',
        label: 'نوع المتابعة النهائية (static/dynamic)',
        defaultValue: 'static'
    },
    course_details: {
        type: 'text',
        category: 'messages',
        label: 'تفاصيل الكورس',
        defaultValue: funnelDefaults.course_details || `📚 *تفاصيل الكورس الشامل للغة الإنجليزية* 📚\n\n- الكورس يغطي جميع المهارات: الاستماع، التحدث، القراءة، والكتابة.\n- محاضرات تفاعلية مباشرة مع مدربين مؤهلين.\n- مناهج معتمدة دولياً ومستويات تناسب الجميع.\n- شهادة معتمدة بنهاية الكورس.\n\n💵 *سعر الكورس:* 500 جنيه مصري فقط بدلاً من 1000 جنيه (خصم لفترة محدودة!).\n\nاختر من الخيارات التالية:\n1️⃣ المحاضرات المجانية 🎥\n2️⃣ الضمانات وآراء العملاء 🤝\n3️⃣ التحويل والدفع الآن 💳\n4️⃣ الرجوع للقائمة السابقة 🔙`
    },
    course_price: {
        type: 'number',
        category: 'messages',
        label: 'سعر الكورس (بالجنيه)',
        defaultValue: 500
    },
    course_features: {
        type: 'text',
        category: 'messages',
        label: 'مميزات الكورس',
        defaultValue: `- محاضرات مباشرة تفاعلية\n- مناهج معتمدة دولياً\n- شهادة معتمدة بنهاية الكورس`
    },
    free_lectures_url: {
        type: 'text',
        category: 'messages',
        label: 'رابط المحاضرات المجانية',
        defaultValue: funnelDefaults.free_lectures_url || 'https://youtube.com/playlist?list=PL_GAC_FREE_LECTURES'
    },
    free_lectures_message: {
        type: 'text',
        category: 'messages',
        label: 'رسالة المحاضرات المجانية',
        defaultValue: funnelDefaults.free_lectures_message || `🎥 يمكنك مشاهدة المحاضرات المجانية والتعريفية بالكورس عبر الرابط التالي:\n\n[LINK]\n\nنتمنى لك مشاهدة ممتعة ومفيدة! 🍿✨`
    },
    guarantees_message: {
        type: 'text',
        category: 'messages',
        label: 'رسالة الضمانات وآراء العملاء',
        defaultValue: funnelDefaults.guarantees_message || `🤝 *لماذا تختار أكاديمية GAC؟*\n\n1. ضمان استرداد الأموال بالكامل خلال أول 7 أيام إذا لم ينل الكورس إعجابك.\n2. تقييمات عملائنا تتحدث عنا! (أكثر من 95% من طلابنا راضون تماماً عن المحتوى).\n3. مدربين متميزين ومتابعة مستمرة خطوة بخطوة.`
    },
    payment_instructions: {
        type: 'text',
        category: 'messages',
        label: 'تعليمات الدفع',
        defaultValue: funnelDefaults.payment_instructions || `💳 *تعليمات الدفع والاشتراك:* 💳\n\nيمكنك التحويل بسهولة عبر الطرق التالية:\n\n- 💸 *Instapay:* gac@instapay\n- 📱 *Vodafone Cash:* 01012345678\n\nبعد التحويل، يرجى القيام بالخطوات التالية:\n1. قم بزيارة رابط التسجيل لإنشاء حسابك:\n[REG_LINK]\n2. أرسل لنا هنا صورة من إيصال التحويل.\n3. أكتب بريدك الإلكتروني المستخدم في التسجيل.\n\nاضغط على زر "تم الدفع" (أو أرسل الرقم 1) بعد إتمام العملية.`
    },
    success_message: {
        type: 'text',
        category: 'messages',
        label: 'رسالة التأكيد بعد الدفع',
        defaultValue: funnelDefaults.success_message || `🎉 شكراً لك! تم استلام إيصال الدفع والبريد الإلكتروني بنجاح.\n\nجاري مراجعة الطلب وتفعيل حسابك خلال دقائق. سنرسل لك رسالة تأكيد فور التفعيل. 🟢`
    },

    // التوقيتات
    no_action_timeout: {
        type: 'number',
        category: 'timers',
        label: 'مدة الانتظار قبل التحويل للمبيعات تلقائياً (بالدقائق)',
        defaultValue: 10
    },
    first_followup_delay: {
        type: 'number',
        category: 'timers',
        label: 'تأخير المتابعة الأولى',
        defaultValue: 24
    },
    first_followup_delay_unit: {
        type: 'text',
        category: 'timers',
        label: 'وحدة تأخير المتابعة الأولى (hours/minutes)',
        defaultValue: 'hours'
    },

    final_followup_delay: {
        type: 'number',
        category: 'timers',
        label: 'تأخير المتابعة النهائية',
        defaultValue: 72
    },
    final_followup_delay_unit: {
        type: 'text',
        category: 'timers',
        label: 'وحدة تأخير المتابعة النهائية (hours/minutes)',
        defaultValue: 'hours'
    },

    // الدفع
    instapay_number: {
        type: 'text',
        category: 'payment',
        label: 'عنوان/رقم إنستاباي',
        defaultValue: '01092308465'
    },
    vodafone_cash_number: {
        type: 'text',
        category: 'payment',
        label: 'رقم فودافون كاش',
        defaultValue: '01092308465'
    },
    payment_link: {
        type: 'text',
        category: 'payment',
        label: 'رابط الدفع الإلكتروني المباشر',
        defaultValue: 'https://gac-academy.com/pay'
    },
    registration_link: {
        type: 'text',
        category: 'payment',
        label: 'رابط التسجيل في المنصة',
        defaultValue: funnelDefaults.registration_link || 'https://gac-academy.com/register'
    },

    // عام
    sales_group_name: {
        type: 'text',
        category: 'general',
        label: 'اسم جروب المبيعات على واتساب',
        defaultValue: 'GAC Sales'
    }
};

// Parse value based on type
function parseValue(value, type) {
    if (value === null || value === undefined) return value;
    if (type === 'number') {
        return Number(value);
    } else if (type === 'boolean') {
        return value === 'true' || value === true;
    } else if (type === 'json') {
        try {
            return typeof value === 'string' ? JSON.parse(value) : value;
        } catch (e) {
            return {};
        }
    }
    return String(value);
}

// Get single setting
export async function getSetting(key, userId) {
    const readOnlyKeys = ['welcome_message', 'course_details', 'free_lectures_url', 'free_lectures_message', 'guarantees_message', 'payment_instructions'];
    
    // Intercept dynamic keys and load from menus & buttons database
    if (readOnlyKeys.includes(key)) {
        try {
            if (key === 'welcome_message') {
                const menu = await InteractiveMenu.findOne({ where: { UserId: userId, isDefault: true, isActive: true } });
                if (menu) return menu.welcomeMessage;
            }
            else if (key === 'course_details') {
                const menu = await InteractiveMenu.findOne({
                    where: {
                        UserId: userId,
                        [Op.or]: [
                            { menuName: { [Op.like]: '%الأسعار%' } },
                            { menuName: { [Op.like]: '%تفاصيل%' } },
                            { triggerWords: { [Op.like]: '%اسعار%' } }
                        ]
                    }
                });
                if (menu) return menu.welcomeMessage;
            }
            else if (key === 'free_lectures_message' || key === 'free_lectures_url') {
                const btn = await InteractiveButton.findOne({
                    where: {
                        UserId: userId,
                        label: { [Op.like]: '%المحاضرات%' }
                    }
                });
                if (btn) {
                    if (key === 'free_lectures_message') {
                        return btn.responseText;
                    } else {
                        const urlMatch = btn.responseText.match(/https?:\/\/[^\s]+/);
                        if (urlMatch) return urlMatch[0];
                    }
                }
            }
            else if (key === 'guarantees_message') {
                const btn = await InteractiveButton.findOne({
                    where: {
                        UserId: userId,
                        label: { [Op.like]: '%الضمانات%' }
                    }
                });
                if (btn) return btn.responseText;
            }
            else if (key === 'payment_instructions') {
                const btn = await InteractiveButton.findOne({
                    where: {
                        UserId: userId,
                        label: { [Op.like]: '%التحويل%' }
                    }
                });
                if (btn) return btn.responseText;
            }
        } catch (err) {
            console.error(`Error dynamically getting key ${key} from menus/buttons:`, err);
        }
    }

    const cacheKey = `${userId}:${key}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    // Check in database
    let setting = await SystemSettings.findOne({ where: { UserId: userId, settingKey: key } });
    if (!setting) {
        // Fallback to default metadata
        const meta = defaultSettingsMeta[key];
        const defaultValue = meta !== undefined ? meta.defaultValue : '';
        const type = meta !== undefined ? meta.type : 'text';
        const category = meta !== undefined ? meta.category : 'general';
        const label = meta !== undefined ? meta.label : key;

        // Auto-seed this single missing key into DB so it persists
        setting = await SystemSettings.create({
            settingKey: key,
            settingValue: typeof defaultValue === 'object' ? JSON.stringify(defaultValue) : String(defaultValue),
            settingType: type,
            category: category,
            label: label,
            UserId: userId
        });

        const parsedVal = parseValue(defaultValue, type);
        cache.set(cacheKey, parsedVal);
        return parsedVal;
    }

    const parsedVal = parseValue(setting.settingValue, setting.settingType);
    cache.set(cacheKey, parsedVal);
    return parsedVal;
}

// Get all settings for a specific category
export async function getSettings(category, userId) {
    const categoryKeys = Object.keys(defaultSettingsMeta).filter(k => defaultSettingsMeta[k].category === category);
    const result = {};
    for (const key of categoryKeys) {
        result[key] = await getSetting(key, userId);
    }
    return result;
}

// Set/Update single setting
export async function setSetting(key, value, userId) {
    const meta = defaultSettingsMeta[key] || { type: 'text', category: 'general', label: key };
    let stringValue = value;
    let parsedValue = value;

    if (meta.type === 'number') {
        parsedValue = Number(value);
        stringValue = String(parsedValue);
    } else if (meta.type === 'boolean') {
        parsedValue = value === 'true' || value === true;
        stringValue = String(parsedValue);
    } else if (meta.type === 'json') {
        parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
        stringValue = JSON.stringify(parsedValue);
    } else {
        stringValue = String(value);
    }

    // Update or Create in DB
    const [setting] = await SystemSettings.findOrCreate({
        where: { UserId: userId, settingKey: key },
        defaults: {
            settingValue: stringValue,
            settingType: meta.type,
            category: meta.category,
            label: meta.label,
            UserId: userId
        }
    });

    if (setting.settingValue !== stringValue) {
        setting.settingValue = stringValue;
        await setting.save();
    }

    // Update Cache
    cache.set(`${userId}:${key}`, parsedValue);
    return parsedValue;
}

// Seed all default settings for a user
export async function seedDefaults(userId) {
    const keys = Object.keys(defaultSettingsMeta);
    for (const key of keys) {
        const meta = defaultSettingsMeta[key];
        const exists = await SystemSettings.findOne({ where: { UserId: userId, settingKey: key } });
        if (!exists) {
            await SystemSettings.create({
                settingKey: key,
                settingValue: typeof meta.defaultValue === 'object' ? JSON.stringify(meta.defaultValue) : String(meta.defaultValue),
                settingType: meta.type,
                category: meta.category,
                label: meta.label,
                UserId: userId
            });
            cache.set(`${userId}:${key}`, meta.defaultValue);
        }
    }
}
