require('dotenv').config();
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const playlistSets = require('./playlists');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const cors = require('cors');

console.log(`Loaded ${Object.keys(playlistSets).length} playlist sets`);

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files with explicit MIME type for .js and logging
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'text/javascript');
    }
  }
}));

// Log static file requests for debugging
app.use((req, res, next) => {
  if (req.path === '/scripts.js' || req.path === '/images/placeholder.jpg') {
    console.log(`Requesting ${req.path} - Resolved to: ${path.join(__dirname, 'public', req.path)}`);
  }
  next();
});

app.use(express.json());
app.use(morgan('dev', { skip: (req) => req.url === '/success' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://illegible.ink', 'https://app.illegible.ink']
    : 'http://localhost:5173',
  methods: ['GET', 'POST'],
  credentials: true
}));

// SQLite setup
const db = new sqlite3.Database('./purchases.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('SQLite connection error:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS purchases (
    userId TEXT,
    setId TEXT,
    purchaseDate INTEGER,
    PRIMARY KEY (userId, setId)
  )`, (err) => {
    if (err) console.error('Table creation error:', err);
  });
});

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

// PKCE utilities
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// Spotify-compliant retry logic
async function retry(fn, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.statusCode || (error.response && error.response.status);
      if (status === 429) {
        const retryAfter = parseInt(error.headers?.['retry-after']) * 1000 || delay * attempt;
        console.warn(`Rate limited. Retrying after ${retryAfter}ms`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
      } else if (status === 401) {
        throw new Error('Authentication expired');
      } else if (status >= 400 && status < 500) {
        throw error;
      } else if (attempt === retries) {
        throw error;
      }
      console.warn(`Attempt ${attempt} failed: ${error.message}. Retrying in ${delay * attempt}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
}

// In-memory storage for auth data
const authStore = new Map();

// Authentication middleware
const requireAuth = async (req, res, next) => {
  try {
    if (!spotifyApi.getAccessToken()) throw new Error('No access token');
    await retry(() => spotifyApi.getMe());
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    spotifyApi.setAccessToken(null);
    return req.method === 'POST'
      ? res.status(401).json({ code: 401, message: 'Authentication required' })
      : res.redirect('/login');
  }
};

// Routes
app.get('/', (req, res) => res.render('launch'));

app.get('/playlists', requireAuth, async (req, res) => {
  try {
    const user = await retry(() => spotifyApi.getMe());
    const userId = user.body.id;

    const purchases = await new Promise((resolve, reject) => {
      db.all('SELECT setId FROM purchases WHERE userId = ?', [userId], (err, rows) => {
        err ? reject(err) : resolve(rows);
      });
    });
    const purchasedSets = new Set(purchases.map(p => p.setId));

    const enrichedSets = await Promise.all(
      Object.entries(playlistSets).map(async ([setId, set], index) => {
        const playlists = Array.isArray(set.playlists) ? set.playlists : (set.playlists ? [set.playlists] : []);
        const albumArts = await getAlbumArts(playlists);
        return [setId, {
          ...set,
          albumArts,
          isFree: index < 10,
          playlists
        }];
      })
    );

    res.render('index', {
      playlistSets: Object.fromEntries(enrichedSets),
      purchasedSets: Array.from(purchasedSets),
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      userId,
      highlightSetId: req.query.highlight
    });
  } catch (error) {
    console.error('Playlists error:', error.stack);
    res.status(500).json({ code: 500, message: 'Internal server error' });
  }
});

async function getAlbumArts(playlists) {
  const albumArts = new Set();
  const fallbackImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='; // 1x1 gray pixel
  for (const playlistId of playlists) {
    try {
      const playlist = await retry(() => spotifyApi.getPlaylist(playlistId));
      for (const item of playlist.body.tracks.items.slice(0, 4)) {
        const art = item.track?.album?.images[0]?.url;
        if (art && albumArts.size < 4) albumArts.add(art);
        if (albumArts.size === 4) break;
      }
      if (albumArts.size === 4) break;
    } catch (err) {
      console.error(`Playlist fetch error ${playlistId}:`, err.message);
    }
  }
  while (albumArts.size < 4) albumArts.add(fallbackImage);
  return Array.from(albumArts);
}

app.get('/login', (req, res) => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  authStore.set(state, codeVerifier);

  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authUrl = `https://accounts.spotify.com/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: process.env.SPOTIFY_CLIENT_ID,
      scope: scopes.join(' '),
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString();

  console.log('Generated auth URL:', authUrl);
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Spotify auth error:', error);
    return res.status(400).json({ code: 400, message: `Authentication failed: ${error}` });
  }

  if (!code || !state) {
    console.error('Missing code or state:', { code, state });
    return res.status(400).json({ code: 400, message: 'Missing authorization code or state' });
  }

  const codeVerifier = authStore.get(state);
  if (!codeVerifier) {
    console.error('Invalid or expired state:', state);
    return res.status(400).json({ code: 400, message: 'Invalid or expired state parameter' });
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        code_verifier: codeVerifier
      }).toString()
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Token exchange failed:', errorData);
      throw new Error(errorData.error_description || 'Token exchange failed');
    }

    const data = await response.json();
    spotifyApi.setAccessToken(data.access_token);
    spotifyApi.setRefreshToken(data.refresh_token || '');

    authStore.delete(state);
    console.log('Authentication successful, access token set');
    res.redirect('/playlists');
  } catch (error) {
    console.error('Callback error:', error.message);
    res.status(400).json({ code: 400, message: `Authentication failed: ${error.message}` });
  }
});

app.get('/checkout', requireAuth, async (req, res) => {
  const { setId } = req.query;
  const set = playlistSets[setId];
  if (!set || set.isFree) return res.redirect('/playlists');

  try {
    const user = await retry(() => spotifyApi.getMe());
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Access to ${set.name} Curation` },
          unit_amount: set.price
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.BASE_URL || 'http://localhost:5173'}/success?session_id={CHECKOUT_SESSION_ID}&setId=${setId}&userId=${user.body.id}`,
      cancel_url: `${process.env.BASE_URL || 'http://localhost:5173'}/playlists`
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error.message);
    res.status(500).json({ code: 500, message: 'Checkout failed' });
  }
});

app.get('/success', async (req, res) => {
  const { session_id, setId, userId } = req.query;
  if (!playlistSets[setId] || !session_id || !userId) return res.redirect('/playlists');

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT OR IGNORE INTO purchases (userId, setId, purchaseDate) VALUES (?, ?, ?)',
          [userId, setId, Date.now()],
          (err) => err ? reject(err) : resolve()
        );
      });
    }
    res.redirect(`/playlists?highlight=${setId}`);
  } catch (error) {
    console.error('Success error:', error.message);
    res.redirect('/playlists');
  }
});

app.post('/save-to-spotify', requireAuth, async (req, res) => {
  const { setId } = req.body;
  const set = playlistSets[setId];
  if (!set) return res.status(400).json({ code: 400, message: 'Invalid set' });

  try {
    const user = await retry(() => spotifyApi.getMe());
    const userId = user.body.id;

    const setIndex = Object.keys(playlistSets).indexOf(setId);
    const isFree = setIndex >= 0 && setIndex < 10;

    if (!isFree) {
      const purchase = await new Promise((resolve) => {
        db.get('SELECT setId FROM purchases WHERE userId = ? AND setId = ?', [userId, setId], (err, row) => {
          resolve(err ? null : row);
        });
      });
      if (!purchase) return res.status(403).json({ code: 403, message: 'Set not purchased' });
    }

    const playlists = Array.isArray(set.playlists) ? set.playlists : (set.playlists ? [set.playlists] : []);
    if (!playlists.length) return res.status(400).json({ code: 400, message: 'No playlists in set' });

    const newPlaylistIds = [];
    for (const playlistId of playlists) {
      const playlist = await retry(() => spotifyApi.getPlaylist(playlistId));
      const tracks = playlist.body.tracks.items.map(item => item.track.uri);
      const newPlaylist = await retry(() => spotifyApi.createPlaylist(userId, {
        name: `${set.name} - Curated by illegible.ink`,
        public: false,
        description: 'Curated playlist by illegible.ink, delivered via Hip Hop Grammar app'
      }));
      await retry(() => spotifyApi.addTracksToPlaylist(newPlaylist.body.id, tracks));
      newPlaylistIds.push(newPlaylist.body.id);
    }
    res.json({ success: true, playlistId: newPlaylistIds[0] });
  } catch (error) {
    console.error('Save error:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({
      code: status,
      message: status === 429 ? 'Rate limit exceeded, please try again later' : 'Failed to save curated playlists'
    });
  }
});

app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));

app.get('/logout', (req, res) => {
  spotifyApi.setAccessToken(null);
  res.redirect('/');
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ code: 500, message: 'Internal server error' });
});

const PORT = process.env.PORT || 5173;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;