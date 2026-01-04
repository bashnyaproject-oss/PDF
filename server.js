const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const PDFMerger = require('pdf-merger-js');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// ============================================
// НАСТРОЙКИ ЛИМИТОВ
// ============================================
const LIMITS = {
    maxFileSize: 50 * 1024 * 1024,
    maxFiles: 20,
    maxRequestsPerMinute: 30,
    fileLifetimeMinutes: 60,
    cleanupIntervalMinutes: 10,
    // Лимиты для бесплатных пользователей
    freeConversionsPerDay: 5,
    freeMaxFileSize: 10 * 1024 * 1024, // 10 МБ для бесплатных
};

// ============================================
// ТАРИФЫ
// ============================================
const PLANS = {
    free: {
        name: 'Бесплатный',
        conversionsPerDay: 5,
        maxFileSize: 10 * 1024 * 1024,
        price: 0
    },
    basic: {
        name: 'Базовый',
        conversionsPerDay: 50,
        maxFileSize: 50 * 1024 * 1024,
        price: 199, // рублей в месяц
        priceId: 'basic_monthly'
    },
    pro: {
        name: 'Про',
        conversionsPerDay: -1, // безлимит
        maxFileSize: 100 * 1024 * 1024,
        price: 499,
        priceId: 'pro_monthly'
    }
};

// ============================================
// Хранилище использования (в продакшене — Redis/БД)
// ============================================
const usageStore = new Map(); // IP -> { count, date, plan, paidUntil }

function getUsage(ip) {
    const today = new Date().toDateString();
    let usage = usageStore.get(ip);
    
    if (!usage || usage.date !== today) {
        usage = { 
            count: 0, 
            date: today, 
            plan: 'free',
            paidUntil: null 
        };
        usageStore.set(ip, usage);
    }
    
    return usage;
}

function incrementUsage(ip) {
    const usage = getUsage(ip);
    usage.count++;
    usageStore.set(ip, usage);
    return usage;
}

function getUserPlan(ip) {
    const usage = getUsage(ip);
    
    // Проверяем оплачен ли план
    if (usage.paidUntil && new Date(usage.paidUntil) > new Date()) {
        return PLANS[usage.plan] || PLANS.free;
    }
    
    return PLANS.free;
}

function checkLimit(ip) {
    const usage = getUsage(ip);
    const plan = getUserPlan(ip);
    
    // Безлимитный план
    if (plan.conversionsPerDay === -1) {
        return { allowed: true, remaining: -1 };
    }
    
    const remaining = plan.conversionsPerDay - usage.count;
    return {
        allowed: remaining > 0,
        remaining: Math.max(0, remaining),
        limit: plan.conversionsPerDay,
        plan: plan.name
    };
}

// Middleware для проверки лимитов
function limitMiddleware(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const check = checkLimit(ip);
    
    if (!check.allowed) {
        return res.status(429).json({
            error: 'Лимит исчерпан',
            message: `Вы использовали все ${check.limit} бесплатных конвертаций на сегодня`,
            upgrade: true,
            plans: PLANS
        });
    }
    
    req.usageCheck = check;
    next();
}

// ============================================
// Папки для файлов
// ============================================
const uploadsDir = path.join(__dirname, 'uploads');
const convertedDir = path.join(__dirname, 'converted');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(convertedDir)) fs.mkdirSync(convertedDir);

// ============================================
// Rate Limiting
// ============================================
const requestCounts = new Map();

function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000;
    
    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
    }
    
    const requests = requestCounts.get(ip).filter(time => now - time < windowMs);
    
    if (requests.length >= LIMITS.maxRequestsPerMinute) {
        return res.status(429).json({ 
            error: 'Слишком много запросов. Подожди минуту.'
        });
    }
    
    requests.push(now);
    requestCounts.set(ip, requests);
    next();
}

// ============================================
// Автоочистка
// ============================================
function cleanupOldFiles() {
    const maxAge = LIMITS.fileLifetimeMinutes * 60 * 1000;
    const now = Date.now();
    
    [uploadsDir, convertedDir].forEach(dir => {
        if (!fs.existsSync(dir)) return;
        
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                }
            } catch (err) {}
        });
    });
}

cleanupOldFiles();
setInterval(cleanupOldFiles, LIMITS.cleanupIntervalMinutes * 60 * 1000);

// ============================================
// Настройка загрузки файлов
// ============================================
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueName + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: LIMITS.maxFileSize,
        files: LIMITS.maxFiles
    }
});

function handleMulterError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ 
                error: `Файл слишком большой. Максимум ${LIMITS.maxFileSize / 1024 / 1024} МБ`,
                upgrade: true
            });
        }
        return res.status(400).json({ error: err.message });
    }
    next(err);
}

// ============================================
// Middleware
// ============================================
app.use(express.static('public'));
app.use(express.json());
app.use('/converted', express.static('converted'));

// ============================================
// API: Лимиты и тарифы
// ============================================
app.get('/api/limits', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const check = checkLimit(ip);
    const plan = getUserPlan(ip);
    
    res.json({
        maxFileSize: plan.maxFileSize,
        maxFileSizeMB: plan.maxFileSize / 1024 / 1024,
        maxFiles: LIMITS.maxFiles,
        fileLifetimeMinutes: LIMITS.fileLifetimeMinutes,
        usage: {
            used: check.limit - check.remaining,
            remaining: check.remaining,
            limit: check.limit,
            plan: plan.name
        }
    });
});

app.get('/api/plans', (req, res) => {
    res.json(PLANS);
});

app.get('/api/usage', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const check = checkLimit(ip);
    const plan = getUserPlan(ip);
    
    res.json({
        used: check.limit === -1 ? 0 : check.limit - check.remaining,
        remaining: check.remaining,
        limit: check.limit,
        plan: plan.name,
        isUnlimited: check.remaining === -1
    });
});

// ============================================
// API: Оплата (заглушка для ЮKassa)
// ============================================
app.post('/api/create-payment', express.json(), (req, res) => {
    const { planId } = req.body;
    const plan = PLANS[planId];
    
    if (!plan || plan.price === 0) {
        return res.status(400).json({ error: 'Неверный тариф' });
    }
    
    // TODO: Интеграция с ЮKassa
    // const payment = await yookassa.createPayment({
    //     amount: { value: plan.price, currency: 'RUB' },
    //     confirmation: { type: 'redirect', return_url: 'https://your-site.ru/payment-success' },
    //     description: `Подписка ${plan.name} на 1 месяц`
    // });
    
    // Пока возвращаем заглушку
    res.json({
        success: false,
        message: 'Платежная система в разработке. Свяжитесь с нами для оплаты.',
        plan: plan,
        // confirmationUrl: payment.confirmation.confirmation_url
    });
});

// Webhook для ЮKassa (когда оплата прошла)
app.post('/api/payment-webhook', express.json(), (req, res) => {
    // TODO: Обработка уведомлений от ЮKassa
    // const { object } = req.body;
    // if (object.status === 'succeeded') {
    //     // Активировать подписку для пользователя
    // }
    
    res.json({ received: true });
});

// ============================================
// API: Конвертация изображений
// ============================================
app.post('/convert', rateLimiter, limitMiddleware, upload.single('file'), handleMulterError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const ip = req.ip || req.connection.remoteAddress;
        const plan = getUserPlan(ip);
        
        // Проверка размера файла для плана
        if (req.file.size > plan.maxFileSize) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                error: `Файл слишком большой для вашего тарифа. Максимум: ${plan.maxFileSize / 1024 / 1024} МБ`,
                upgrade: true
            });
        }

        const format = req.body.format || 'jpeg';
        const quality = parseInt(req.body.quality) || 80;
        const width = req.body.width ? parseInt(req.body.width) : null;
        const height = req.body.height ? parseInt(req.body.height) : null;
        const fit = req.body.fit || 'inside';
        
        const inputPath = req.file.path;
        const outputName = Date.now() + '.' + (format === 'jpg' ? 'jpg' : format);
        const outputPath = path.join(convertedDir, outputName);

        let sharpInstance = sharp(inputPath);
        const metadata = await sharpInstance.metadata();

        if (width || height) {
            sharpInstance = sharpInstance.resize(width, height, {
                fit: fit,
                withoutEnlargement: true
            });
        }

        if (format === 'jpeg' || format === 'jpg') {
            sharpInstance = sharpInstance.jpeg({ quality: quality });
        } else if (format === 'png') {
            sharpInstance = sharpInstance.png({ compressionLevel: Math.round((100 - quality) / 10) });
        } else if (format === 'webp') {
            sharpInstance = sharpInstance.webp({ quality: quality });
        } else if (format === 'avif') {
            sharpInstance = sharpInstance.avif({ quality: quality });
        } else if (format === 'tiff') {
            sharpInstance = sharpInstance.tiff({ quality: quality });
        } else if (format === 'gif') {
            sharpInstance = sharpInstance.gif();
        }

        await sharpInstance.toFile(outputPath);
        
        const outputMetadata = await sharp(outputPath).metadata();
        const stats = fs.statSync(outputPath);
        
        fs.unlinkSync(inputPath);
        
        // Увеличиваем счётчик использования
        const usage = incrementUsage(ip);
        const check = checkLimit(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            fileName: outputName,
            size: formatBytes(stats.size),
            sizeBytes: stats.size,
            width: outputMetadata.width,
            height: outputMetadata.height,
            usage: {
                remaining: check.remaining,
                limit: check.limit
            }
        });

    } catch (error) {
        console.error('Ошибка конвертации:', error);
        res.status(500).json({ error: 'Ошибка: ' + error.message });
    }
});

// ============================================
// API: Информация об изображении
// ============================================
app.post('/image-info', rateLimiter, upload.single('file'), handleMulterError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const inputPath = req.file.path;
        const stats = fs.statSync(inputPath);
        const metadata = await sharp(inputPath).metadata();

        fs.unlinkSync(inputPath);

        res.json({
            success: true,
            width: metadata.width,
            height: metadata.height,
            format: metadata.format,
            size: formatBytes(stats.size),
            sizeBytes: stats.size
        });

    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Изображения → PDF
// ============================================
app.post('/images-to-pdf', rateLimiter, limitMiddleware, upload.array('files', LIMITS.maxFiles), handleMulterError, async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Файлы не загружены' });
        }

        const ip = req.ip || req.connection.remoteAddress;

        let order = [];
        try {
            order = JSON.parse(req.body.order || '[]');
        } catch (e) {
            order = req.files.map((_, i) => i);
        }

        const pdfDoc = await PDFDocument.create();

        for (const idx of order) {
            const file = req.files[idx];
            if (!file) continue;
            
            const imageBuffer = fs.readFileSync(file.path);
            const ext = path.extname(file.originalname).toLowerCase();
            
            let image;
            if (ext === '.jpg' || ext === '.jpeg') {
                image = await pdfDoc.embedJpg(imageBuffer);
            } else if (ext === '.png') {
                image = await pdfDoc.embedPng(imageBuffer);
            } else {
                const pngBuffer = await sharp(file.path).png().toBuffer();
                image = await pdfDoc.embedPng(pngBuffer);
            }

            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, {
                x: 0,
                y: 0,
                width: image.width,
                height: image.height,
            });
        }

        for (const file of req.files) {
            fs.unlinkSync(file.path);
        }

        const pdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '.pdf';
        const outputPath = path.join(convertedDir, outputName);
        fs.writeFileSync(outputPath, pdfBytes);

        // Увеличиваем счётчик
        incrementUsage(ip);
        const check = checkLimit(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            fileName: outputName,
            size: formatBytes(pdfBytes.length),
            pages: order.length,
            usage: { remaining: check.remaining, limit: check.limit }
        });

    } catch (error) {
        console.error('Ошибка создания PDF:', error);
        res.status(500).json({ error: 'Ошибка: ' + error.message });
    }
});

// ============================================
// API: Объединить PDF
// ============================================
app.post('/merge-pdf', rateLimiter, limitMiddleware, upload.array('files', LIMITS.maxFiles), handleMulterError, async (req, res) => {
    try {
        if (!req.files || req.files.length < 2) {
            return res.status(400).json({ error: 'Нужно минимум 2 PDF файла' });
        }

        const ip = req.ip || req.connection.remoteAddress;

        let order = [];
        try {
            order = JSON.parse(req.body.order || '[]');
        } catch (e) {
            order = req.files.map((_, i) => i);
        }

        const merger = new PDFMerger();

        for (const idx of order) {
            const file = req.files[idx];
            if (file) {
                await merger.add(file.path);
            }
        }

        const outputName = Date.now() + '-merged.pdf';
        const outputPath = path.join(convertedDir, outputName);
        
        await merger.save(outputPath);

        for (const file of req.files) {
            fs.unlinkSync(file.path);
        }

        const stats = fs.statSync(outputPath);

        incrementUsage(ip);
        const check = checkLimit(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            fileName: outputName,
            size: formatBytes(stats.size),
            usage: { remaining: check.remaining, limit: check.limit }
        });

    } catch (error) {
        console.error('Ошибка объединения PDF:', error);
        res.status(500).json({ error: 'Ошибка: ' + error.message });
    }
});

// ============================================
// API: Сжатие PDF
// ============================================
app.post('/compress-pdf', rateLimiter, limitMiddleware, upload.single('file'), handleMulterError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const ip = req.ip || req.connection.remoteAddress;

        const inputPath = req.file.path;
        const originalSize = fs.statSync(inputPath).size;

        const existingPdfBytes = fs.readFileSync(inputPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes, { 
            ignoreEncryption: true 
        });
        
        const compressedBytes = await pdfDoc.save({
            useObjectStreams: true,
            addDefaultPage: false
        });

        const outputName = Date.now() + '-compressed.pdf';
        const outputPath = path.join(convertedDir, outputName);
        fs.writeFileSync(outputPath, compressedBytes);
        fs.unlinkSync(inputPath);

        const newSize = compressedBytes.length;
        const savings = Math.round((1 - newSize / originalSize) * 100);

        incrementUsage(ip);
        const check = checkLimit(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            fileName: outputName,
            originalSize: formatBytes(originalSize),
            newSize: formatBytes(newSize),
            savings: savings > 0 ? savings + '%' : '0%',
            usage: { remaining: check.remaining, limit: check.limit }
        });

    } catch (error) {
        console.error('Ошибка сжатия PDF:', error);
        res.status(500).json({ error: 'Ошибка: ' + error.message });
    }
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Запуск сервера
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 Сервер запущен!');
    console.log('');
    console.log('   Открой в браузере: http://localhost:' + PORT);
    console.log('');
    console.log('💰 Тарифы:');
    Object.entries(PLANS).forEach(([key, plan]) => {
        console.log(`   • ${plan.name}: ${plan.conversionsPerDay === -1 ? '∞' : plan.conversionsPerDay} конв./день, ${plan.price} ₽/мес`);
    });
    console.log('');
});
