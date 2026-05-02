#!/usr/bin/env node
// Bootstrap OAuth Google para procesar-facturas.
// Uso (una sola vez):
//   1. Pega GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en .env.local
//   2. node --env-file=.env.local scripts/setup-oauth.mjs
//   3. Autoriza en el browser
//   4. Copia el GOOGLE_OAUTH_REFRESH_TOKEN que se imprime al .env.local

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('\n❌ Falta GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en .env.local');
  console.error('   Crea el OAuth client en https://console.cloud.google.com (tipo "Desktop")');
  console.error('   y pega los dos valores antes de correr este script.\n');
  process.exit(1);
}

const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);

const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\n=== Setup OAuth Google (procesar-facturas) ===\n');
console.log('Abriendo browser para autorizar...\n');
console.log('Si no abre, copia esta URL:\n');
console.log(url);
console.log('\nEsperando callback en http://localhost:' + PORT + ' ...\n');

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error');
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
       .end(`<h1>Error</h1><p>${error}</p>`);
    console.error('\n❌ Google devolvió error:', error);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end('Falta code en la URL');
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
         .end('<h1>Sin refresh_token</h1><p>Revoca el acceso en https://myaccount.google.com/permissions y vuelve a correr.</p>');
      console.error('\n❌ Google NO devolvió refresh_token. Causas comunes:');
      console.error('   - Ya autorizaste antes con este client. Solución: revoca el acceso en');
      console.error('     https://myaccount.google.com/permissions y corre el script de nuevo.');
      console.error('   - El OAuth client no es de tipo "Desktop".\n');
      server.close();
      process.exit(1);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
       .end('<h1>✅ Listo</h1><p>Vuelve a la terminal y copia el refresh token al .env.local</p>');

    console.log('\n✅ Refresh token obtenido. Pega ESTA línea en tu .env.local:\n');
    console.log('────────────────────────────────────────────────────────');
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('────────────────────────────────────────────────────────\n');
    console.log('Después corre:');
    console.log('   node --env-file=.env.local scripts/procesar-facturas.mjs --dry-run\n');
    console.log('para verificar que detecta tus facturas pendientes (sin tocarlas).\n');

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500).end('Error: ' + err.message);
    console.error('\n❌ Falló intercambio de code por tokens:', err.message, '\n');
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  // No auto-open: en Windows, escapar el URL para `start` rompe el response_type.
  // Mejor que el usuario haga click/copy del URL impreso arriba.
  if (process.platform === 'darwin') {
    exec(`open "${url}"`, () => {});
  } else if (process.platform !== 'win32') {
    exec(`xdg-open "${url}"`, () => {});
  }
  // En Windows: solo imprime, no auto-abre. Ya está claro arriba con "copia esta URL".
});

// Sin timeout — el server queda vivo hasta que recibas el callback o hagas Ctrl+C.
// Si por alguna razón quieres pararlo: Ctrl+C en esta terminal.
