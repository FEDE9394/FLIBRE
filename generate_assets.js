const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');

// Crear directorios si no existen
const iconsDir = path.join(__dirname, 'resources', 'media', 'icons');
const fanartDir = path.join(__dirname, 'resources', 'media', 'fanart');

if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
if (!fs.existsSync(fanartDir)) fs.mkdirSync(fanartDir, { recursive: true });

// Función para crear un icono con emoji renderizado
function createEmojiIcon(size, emoji, bgColor, outputPath) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Fondo con gradiente radial
    const centerX = size / 2;
    const centerY = size / 2;
    const maxDist = Math.sqrt(centerX ** 2 + centerY ** 2);

    // Crear gradiente radial
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxDist);
    gradient.addColorStop(0, `rgb(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]})`);
    gradient.addColorStop(1, `rgb(${Math.round(bgColor[0] * 0.6)}, ${Math.round(bgColor[1] * 0.6)}, ${Math.round(bgColor[2] * 0.6)})`);

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // Dibujar borde redondeado
    ctx.strokeStyle = `rgb(${Math.round(bgColor[0] * 0.4)}, ${Math.round(bgColor[1] * 0.4)}, ${Math.round(bgColor[2] * 0.4)})`;
    ctx.lineWidth = size * 0.08;
    ctx.beginPath();
    ctx.arc(centerX, centerY, (size / 2) - (size * 0.04), 0, Math.PI * 2);
    ctx.stroke();

    // Dibujar el emoji en el centro
    ctx.font = `${size * 0.6}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, centerX, centerY);

    // Guardar como PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Creado icono con emoji: ${outputPath}`);
}

// Función para crear un PNG con círculos decorativos
function createCirclePatternPNG(width, height, bgColor, circleColor, outputPath) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fondo
    ctx.fillStyle = `rgb(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]})`;
    ctx.fillRect(0, 0, width, height);

    // Círculos decorativos
    const circles = [
        { cx: width * 0.2, cy: height * 0.3, r: 60 },
        { cx: width * 0.8, cy: height * 0.7, r: 80 },
        { cx: width * 0.5, cy: height * 0.5, r: 100 },
        { cx: width * 0.1, cy: height * 0.9, r: 50 },
        { cx: width * 0.9, cy: height * 0.1, r: 70 }
    ];

    for (const circle of circles) {
        const gradient = ctx.createRadialGradient(circle.cx, circle.cy, 0, circle.cx, circle.cy, circle.r);
        gradient.addColorStop(0, `rgba(${circleColor[0]}, ${circleColor[1]}, ${circleColor[2]}, 0.3)`);
        gradient.addColorStop(1, `rgba(${circleColor[0]}, ${circleColor[1]}, ${circleColor[2]}, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(circle.cx, circle.cy, circle.r, 0, Math.PI * 2);
        ctx.fill();
    }

    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Creado: ${outputPath}`);
}

// Función para crear un PNG con patrón de líneas diagonales
function createPatternPNG(width, height, bgColor, lineColor, outputPath) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fondo
    ctx.fillStyle = `rgb(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]})`;
    ctx.fillRect(0, 0, width, height);

    // Patrón de líneas diagonales
    ctx.strokeStyle = `rgba(${lineColor[0]}, ${lineColor[1]}, ${lineColor[2]}, 0.15)`;
    ctx.lineWidth = 2;

    for (let i = -height; i < width + height; i += 20) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + height, height);
        ctx.stroke();
    }

    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Creado: ${outputPath}`);
}

// Colores para el tema de fútbol
const primaryGreen = [0, 150, 50];      // Verde cancha
const darkGreen = [0, 100, 30];         // Verde oscuro
const accentGold = [255, 200, 0];       // Dorado
const darkBlue = [10, 20, 40];          // Azul oscuro
const lightBlue = [30, 60, 120];        // Azul medio
const red = [200, 30, 30];              // Rojo

console.log('Generando recursos visuales para Fútbol Libre TV...\n');

// 1. Icono principal del addon (512x512) - ⚽
createEmojiIcon(512, '⚽', darkBlue, path.join(iconsDir, 'icon.png'));

// 2. Icono para Canales en Vivo (256x256) - 📺
createEmojiIcon(256, '📺', primaryGreen, path.join(iconsDir, 'channels.png'));

// 3. Icono para Agenda (256x256) - 📅
createEmojiIcon(256, '📅', darkBlue, path.join(iconsDir, 'agenda.png'));

// 4. Icono para configuración (256x256) - ⚙️
createEmojiIcon(256, '⚙️', lightBlue, path.join(iconsDir, 'settings.png'));

// 5. Icono para favoritos (256x256) - ⭐
createEmojiIcon(256, '⭐', accentGold, path.join(iconsDir, 'favorites.png'));

// 6. Fanart principal (1920x1080)
createCirclePatternPNG(1920, 1080, darkBlue, primaryGreen, path.join(fanartDir, 'fanart.jpg'));

// 7. Fanart alternativo con patrón (1920x1080)
createPatternPNG(1920, 1080, darkBlue, primaryGreen, path.join(fanartDir, 'fanart_alt.jpg'));

console.log('\n✓ Recursos visuales generados exitosamente!');
console.log('  - Iconos: ' + iconsDir);
console.log('  - Fanarts: ' + fanartDir);
console.log('\nLos iconos tienen emojis renderizados: ⚽ 📺 📅 ⚙️ ⭐');