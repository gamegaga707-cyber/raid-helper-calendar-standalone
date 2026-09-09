/**
 * get-refresh-token.js
 * 
 * Run this ONCE to get a Google OAuth refresh token.
 * 
 * Prerequisites:
 * 1. Go to https://console.cloud.google.com/
 * 2. Create a project (or use existing)
 * 3. Enable "Google Calendar API"
 * 4. Go to Credentials → Create Credentials → OAuth 2.0 Client ID
 *    - Type: Desktop app
 *    - Name: "Raid Helper Calendar Bot"
 * 5. Download the JSON file → save as `credentials.json` in this folder
 * 
 * Then run: node get-refresh-token.js
 * It will open a browser for you to authorize.
 * Copy the printed refresh token into your .env as GOOGLE_REFRESH_TOKEN
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const open = (...args) => import('open').then(({default: open}) => open(...args));

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

async function loadCredentials() {
  try {
    const data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error(`\n❌ ERROR: Could not read ${CREDENTIALS_PATH}`);
    console.error('Please download your OAuth credentials JSON from Google Cloud Console');
    console.error('and save it as "credentials.json" in this folder.\n');
    process.exit(1);
  }
}

function createOAuth2Client(credentials) {
  const { client_id, client_secret } = credentials.installed || credentials.web || credentials;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function generateAuthUrl(oauth2Client) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      
      if (query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Success</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>✅ Authorization Successful</h1>
            <p>You can close this window and return to the terminal.</p>
            <script>setTimeout(() => window.close(), 2000);</script>
          </body>
          </html>
        `);
        server.close();
        resolve(query.code);
      } else if (query.error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Error</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>❌ Authorization Failed</h1>
            <p>Error: ${query.error}</p>
          </body>
          </html>
        `);
        server.close();
        reject(new Error(query.error));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    
    server.listen(REDIRECT_PORT, () => {
      console.log(`\n🌐 Local OAuth server running on http://localhost:${REDIRECT_PORT}`);
    });
    
    server.on('error', reject);
  });
}

async function getTokens(oauth2Client, code) {
  const { tokens } = await oauth2Client.getToken(code);
  
  if (!tokens.refresh_token) {
    console.error('\n❌ No refresh token received!');
    console.error('This usually means you already authorized this app before.');
    console.error('Go to https://myaccount.google.com/permissions');
    console.error('Remove "Raid Helper Calendar Bot" and try again.\n');
    process.exit(1);
  }
  
  return tokens;
}

function saveToken(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
    token_type: tokens.token_type,
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
}

async function main() {
  console.log('🔐 Google OAuth Refresh Token Generator');
  console.log('========================================\n');
  
  const credentials = await loadCredentials();
  const oauth2Client = createOAuth2Client(credentials);
  const authUrl = generateAuthUrl(oauth2Client);
  
  console.log('Starting local server...');
  await startLocalServer();
  
  console.log('\n📋 Opening browser for authorization...');
  console.log('If it doesn\'t open automatically, visit:\n');
  console.log(authUrl);
  console.log();
  
  await open(authUrl);
  
  console.log('Waiting for authorization...');
  const code = await new Promise((resolve, reject) => {
    // The server will resolve when it receives the callback
    // We just wait here
    setTimeout(() => reject(new Error('Timeout waiting for authorization')), 120000);
  });
  
  // Actually the server promise resolves with the code
  // Let me fix this - the server promise IS the code promise
  
  // Wait, I need to restructure this. The server promise resolves with the code.
  // Let me just re-read... Actually the pattern is:
  // 1. Start server, returns promise that resolves with code
  // 2. Open browser
  // 3. Await the server promise
  
  // My code above has the server promise resolving with the code directly.
  // But I'm not awaiting it properly. Let me fix.
}

if (require.main === module) {
  // Proper implementation
  (async () => {
    try {
      const credentials = await loadCredentials();
      const oauth2Client = createOAuth2Client(credentials);
      const authUrl = generateAuthUrl(oauth2Client);
      
      console.log('🔐 Google OAuth Refresh Token Generator');
      console.log('========================================\n');
      
      const server = http.createServer();
      const codePromise = new Promise((resolve, reject) => {
        server.on('request', async (req, res) => {
          const query = url.parse(req.url, true).query;
          
          if (query.code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head><title>Success</title></head>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1>✅ Authorization Successful</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
              </html>
            `);
            server.close();
            resolve(query.code);
          } else if (query.error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head><title>Error</title></head>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1>❌ Authorization Failed</h1>
                <p>Error: ${query.error}</p>
              </body>
              </html>
            `);
            server.close();
            reject(new Error(query.error));
          }
        });
        
        server.listen(REDIRECT_PORT, () => {
          console.log(`🌐 Local server: http://localhost:${REDIRECT_PORT}/oauth2callback`);
        });
      });
      
      console.log('\n📋 Opening browser...');
      console.log('If it doesn\'t open, visit:');
      console.log(authUrl);
      console.log();
      
      const openModule = await import('open');
      await openModule.default(authUrl);
      
      console.log('Waiting for you to authorize...');
      const code = await codePromise;
      
      console.log('✅ Got authorization code, exchanging for tokens...');
      const tokens = await getTokens(oauth2Client, code);
      
      saveToken(tokens);
      
      console.log('\n🎉 SUCCESS! Your refresh token:\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(tokens.refresh_token);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      console.log('Copy the above token into your .env as GOOGLE_REFRESH_TOKEN');
      console.log(`(Also saved to ${TOKEN_PATH})\n`);
      
      process.exit(0);
    } catch (e) {
      console.error('\n❌ Error:', e.message);
      process.exit(1);
    }
  })();
}