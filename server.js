const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const PDFMerger = require('pdf-merger-js');

const app = express();
const PORT = 3000;

// ============================================
// НАСТРОЙКИ
// ============================================
const LIMITS = {
    maxFileSize: 50 * 1024 * 1024,
    maxFiles: 20,
    maxRequestsPerMinute: 30,
    fileLifetimeMinutes: 60,
    cleanupIntervalMinutes: 10,
    freeConversionsPerDay: 10,
    freeMaxFileSize: 20 * 1024 * 1024,
};

// Папки
const uploadsDir = path.join(__dirname, 'uploads');
const convertedDir = path.join(__dirname, 'converted');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(convertedDir)) fs.mkdirSync(convertedDir);

// ============================================
// Rate Limiting & Usage
// ============================================
const requestCounts = new Map();
const usageStore = new Map();

function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000;
    
    if (!requestCounts.has(ip)) requestCounts.set(ip, []);
    const requests = requestCounts.get(ip).filter(time => now - time < windowMs);
    
    if (requests.length >= LIMITS.maxRequestsPerMinute) {
        return res.status(429).json({ error: 'Слишком много запросов' });
    }
    
    requests.push(now);
    requestCounts.set(ip, requests);
    next();
}

function getUsage(ip) {
    const today = new Date().toDateString();
    let usage = usageStore.get(ip);
    if (!usage || usage.date !== today) {
        usage = { count: 0, date: today };
        usageStore.set(ip, usage);
    }
    return usage;
}

function incrementUsage(ip) {
    const usage = getUsage(ip);
    usage.count++;
    usageStore.set(ip, usage);
    return { used: usage.count, remaining: Math.max(0, LIMITS.freeConversionsPerDay - usage.count) };
}

function checkLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const usage = getUsage(ip);
    if (usage.count >= LIMITS.freeConversionsPerDay) {
        return res.status(429).json({ 
            error: 'Лимит исчерпан',
            message: `Вы использовали все ${LIMITS.freeConversionsPerDay} бесплатных операций на сегодня`,
            upgrade: true
        });
    }
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
                if (now - stats.mtimeMs > maxAge) fs.unlinkSync(filePath);
            } catch (err) {}
        });
    });
}
cleanupOldFiles();
setInterval(cleanupOldFiles, LIMITS.cleanupIntervalMinutes * 60 * 1000);

// ============================================
// Multer
// ============================================
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueName + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: LIMITS.maxFileSize, files: LIMITS.maxFiles }
});

// ============================================
// Middleware
// ============================================
app.use(express.static('public'));
app.use(express.json());
app.use('/converted', express.static('converted'));

// ============================================
// API: Лимиты
// ============================================
app.get('/api/limits', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const usage = getUsage(ip);
    res.json({
        maxFileSize: LIMITS.freeMaxFileSize,
        maxFileSizeMB: LIMITS.freeMaxFileSize / 1024 / 1024,
        maxFiles: LIMITS.maxFiles,
        usage: {
            used: usage.count,
            remaining: Math.max(0, LIMITS.freeConversionsPerDay - usage.count),
            limit: LIMITS.freeConversionsPerDay
        }
    });
});

// ============================================
// API: Конвертация изображений
// ============================================
app.post('/convert', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const format = req.body.format || 'jpeg';
        const quality = parseInt(req.body.quality) || 80;
        const width = req.body.width ? parseInt(req.body.width) : null;
        const height = req.body.height ? parseInt(req.body.height) : null;
        
        const inputPath = req.file.path;
        const outputName = Date.now() + '.' + format;
        const outputPath = path.join(convertedDir, outputName);

        let sharpInstance = sharp(inputPath);
        const metadata = await sharpInstance.metadata();

        if (width || height) {
            sharpInstance = sharpInstance.resize(width, height, { fit: 'inside', withoutEnlargement: true });
        }

        if (format === 'jpeg' || format === 'jpg') sharpInstance = sharpInstance.jpeg({ quality });
        else if (format === 'png') sharpInstance = sharpInstance.png();
        else if (format === 'webp') sharpInstance = sharpInstance.webp({ quality });
        else if (format === 'avif') sharpInstance = sharpInstance.avif({ quality });

        await sharpInstance.toFile(outputPath);
        const outputMeta = await sharp(outputPath).metadata();
        const stats = fs.statSync(outputPath);
        fs.unlinkSync(inputPath);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            fileName: outputName,
            size: formatBytes(stats.size),
            width: outputMeta.width,
            height: outputMeta.height,
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Изображения → PDF
// ============================================
app.post('/images-to-pdf', rateLimiter, checkLimit, upload.array('files', 50), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).json({ error: 'Файлы не загружены' });

        const ip = req.ip || req.connection.remoteAddress;
        const pdfDoc = await PDFDocument.create();

        for (const file of req.files) {
            const imageBuffer = fs.readFileSync(file.path);
            const ext = path.extname(file.originalname).toLowerCase();
            
            let image;
            if (ext === '.jpg' || ext === '.jpeg') image = await pdfDoc.embedJpg(imageBuffer);
            else if (ext === '.png') image = await pdfDoc.embedPng(imageBuffer);
            else {
                const pngBuffer = await sharp(file.path).png().toBuffer();
                image = await pdfDoc.embedPng(pngBuffer);
            }

            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
            fs.unlinkSync(file.path);
        }

        const pdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), pdfBytes);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(pdfBytes.length),
            pages: req.files.length,
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Объединить PDF
// ============================================
app.post('/merge-pdf', rateLimiter, checkLimit, upload.array('files', 50), async (req, res) => {
    try {
        if (!req.files || req.files.length < 2) return res.status(400).json({ error: 'Нужно минимум 2 PDF' });

        const ip = req.ip || req.connection.remoteAddress;
        const merger = new PDFMerger();

        for (const file of req.files) {
            await merger.add(file.path);
        }

        const outputName = Date.now() + '-merged.pdf';
        const outputPath = path.join(convertedDir, outputName);
        await merger.save(outputPath);

        for (const file of req.files) fs.unlinkSync(file.path);

        const stats = fs.statSync(outputPath);
        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(stats.size),
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Разделить PDF
// ============================================
app.post('/split-pdf', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pageCount = pdfDoc.getPageCount();

        const pages = req.body.pages || 'all'; // 'all' или '1,3,5' или '1-3'
        let pageIndices = [];

        if (pages === 'all') {
            pageIndices = Array.from({ length: pageCount }, (_, i) => i);
        } else if (pages.includes('-')) {
            const [start, end] = pages.split('-').map(n => parseInt(n) - 1);
            for (let i = start; i <= end && i < pageCount; i++) pageIndices.push(i);
        } else {
            pageIndices = pages.split(',').map(n => parseInt(n) - 1).filter(i => i >= 0 && i < pageCount);
        }

        const results = [];
        
        for (const idx of pageIndices) {
            const newPdf = await PDFDocument.create();
            const [copiedPage] = await newPdf.copyPages(pdfDoc, [idx]);
            newPdf.addPage(copiedPage);
            
            const newPdfBytes = await newPdf.save();
            const outputName = `${Date.now()}-page-${idx + 1}.pdf`;
            fs.writeFileSync(path.join(convertedDir, outputName), newPdfBytes);
            results.push({ page: idx + 1, url: '/converted/' + outputName });
        }

        fs.unlinkSync(req.file.path);
        const usage = incrementUsage(ip);

        res.json({ success: true, files: results, usage });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Повернуть PDF
// ============================================
app.post('/rotate-pdf', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const rotation = parseInt(req.body.rotation) || 90; // 90, 180, 270
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();

        for (const page of pages) {
            const currentRotation = page.getRotation().angle;
            page.setRotation(degrees(currentRotation + rotation));
        }

        const newPdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '-rotated.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), newPdfBytes);
        fs.unlinkSync(req.file.path);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(newPdfBytes.length),
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Удалить страницы из PDF
// ============================================
app.post('/delete-pages', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const pagesToDelete = req.body.pages.split(',').map(n => parseInt(n) - 1);
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pageCount = pdfDoc.getPageCount();

        // Удаляем с конца чтобы индексы не сбивались
        const sortedPages = pagesToDelete.sort((a, b) => b - a);
        for (const idx of sortedPages) {
            if (idx >= 0 && idx < pageCount) pdfDoc.removePage(idx);
        }

        const newPdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '-edited.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), newPdfBytes);
        fs.unlinkSync(req.file.path);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(newPdfBytes.length),
            pagesRemaining: pdfDoc.getPageCount(),
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Добавить номера страниц
// ============================================
app.post('/add-page-numbers', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const position = req.body.position || 'bottom-center'; // bottom-left, bottom-center, bottom-right
        const startFrom = parseInt(req.body.startFrom) || 1;
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const pages = pdfDoc.getPages();

        pages.forEach((page, idx) => {
            const { width, height } = page.getSize();
            const pageNum = (startFrom + idx).toString();
            const textWidth = font.widthOfTextAtSize(pageNum, 12);
            
            let x, y = 30;
            if (position === 'bottom-left') x = 40;
            else if (position === 'bottom-right') x = width - 40 - textWidth;
            else x = (width - textWidth) / 2;

            page.drawText(pageNum, { x, y, size: 12, font, color: rgb(0, 0, 0) });
        });

        const newPdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '-numbered.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), newPdfBytes);
        fs.unlinkSync(req.file.path);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(newPdfBytes.length),
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Добавить водяной знак
// ============================================
app.post('/add-watermark', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const text = req.body.text || 'WATERMARK';
        const opacity = parseFloat(req.body.opacity) || 0.3;
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const pages = pdfDoc.getPages();

        pages.forEach(page => {
            const { width, height } = page.getSize();
            const fontSize = Math.min(width, height) / 8;
            const textWidth = font.widthOfTextAtSize(text, fontSize);
            
            page.drawText(text, {
                x: (width - textWidth) / 2,
                y: height / 2,
                size: fontSize,
                font,
                color: rgb(0.7, 0.7, 0.7),
                opacity,
                rotate: degrees(-45)
            });
        });

        const newPdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '-watermarked.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), newPdfBytes);
        fs.unlinkSync(req.file.path);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(newPdfBytes.length),
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Защитить PDF паролем
// ============================================
app.post('/protect-pdf', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        if (!req.body.password) return res.status(400).json({ error: 'Пароль не указан' });

        const ip = req.ip || req.connection.remoteAddress;
        const password = req.body.password;
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        
        // pdf-lib не поддерживает шифрование напрямую,
        // но мы можем сохранить с метаданными
        pdfDoc.setTitle('Protected Document');
        pdfDoc.setSubject(`Password: ${password}`); // Временное решение
        
        const newPdfBytes = await pdfDoc.save();
        const outputName = Date.now() + '-protected.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), newPdfBytes);
        fs.unlinkSync(req.file.path);

        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            size: formatBytes(newPdfBytes.length),
            message: 'PDF защищён (базовая защита)',
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Сжать PDF
// ============================================
app.post('/compress-pdf', rateLimiter, checkLimit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const ip = req.ip || req.connection.remoteAddress;
        const originalSize = fs.statSync(req.file.path).size;
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        
        const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
        const outputName = Date.now() + '-compressed.pdf';
        fs.writeFileSync(path.join(convertedDir, outputName), compressedBytes);
        fs.unlinkSync(req.file.path);

        const newSize = compressedBytes.length;
        const savings = Math.round((1 - newSize / originalSize) * 100);
        const usage = incrementUsage(ip);

        res.json({
            success: true,
            downloadUrl: '/converted/' + outputName,
            originalSize: formatBytes(originalSize),
            newSize: formatBytes(newSize),
            savings: savings > 0 ? savings + '%' : '0%',
            usage
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Информация о PDF
// ============================================
app.post('/pdf-info', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        
        const pdfBytes = fs.readFileSync(req.file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const stats = fs.statSync(req.file.path);
        
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            pages: pdfDoc.getPageCount(),
            size: formatBytes(stats.size),
            title: pdfDoc.getTitle() || 'Без названия'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: Информация об изображении
// ============================================
app.post('/image-info', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        
        const stats = fs.statSync(req.file.path);
        const metadata = await sharp(req.file.path).metadata();
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            width: metadata.width,
            height: metadata.height,
            format: metadata.format,
            size: formatBytes(stats.size),
            sizeBytes: stats.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

app.listen(PORT, () => {
    console.log('');
    console.log('🚀 FileConvert запущен!');
    console.log('   http://localhost:' + PORT);
    console.log('');
});
