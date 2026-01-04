#!/bin/bash

# ===========================================
# Скрипт деплоя FileConvert на Ubuntu 22.04
# Запускать на сервере от root
# ===========================================

set -e

echo "🚀 Начинаем деплой FileConvert..."

# Обновление системы
echo "📦 Обновление системы..."
apt update && apt upgrade -y

# Установка Node.js 20
echo "📦 Установка Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Установка Nginx
echo "📦 Установка Nginx..."
apt install -y nginx

# Установка PM2
echo "📦 Установка PM2..."
npm install -g pm2

# Создаём папку проекта
echo "📁 Создание папки проекта..."
mkdir -p /var/www/fileconvert
cd /var/www/fileconvert

# Если файлы уже есть — используем их
if [ -f "package.json" ]; then
    echo "📦 Установка зависимостей..."
    npm install --production
else
    echo "⚠️ Файлы проекта не найдены!"
    echo "   Загрузи файлы в /var/www/fileconvert"
    exit 1
fi

# Создаём папки для файлов
mkdir -p uploads converted

# Права на папки
chown -R www-data:www-data /var/www/fileconvert
chmod -R 755 /var/www/fileconvert

# Настройка Nginx
echo "⚙️ Настройка Nginx..."
cp nginx.conf /etc/nginx/sites-available/fileconvert
ln -sf /etc/nginx/sites-available/fileconvert /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Запуск через PM2
echo "🚀 Запуск приложения..."
pm2 delete fileconvert 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root

# Готово!
echo ""
echo "✅ Деплой завершён!"
echo ""
echo "🌐 Сайт доступен: http://$(curl -s ifconfig.me)"
echo ""
echo "📋 Полезные команды:"
echo "   pm2 logs        - логи приложения"
echo "   pm2 restart all - перезапуск"
echo "   pm2 status      - статус"
echo ""

