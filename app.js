require('dotenv').config();
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const playlistSets = require('./playlists');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

// Validate environment variables
const requiredEnvVars = ['DATABASE_URL', 'SESSION_SECRET', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_REDIRECT_URI', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'BASE_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
  }
}));

app.use(express.json());
app.use(morgan('combined', { skip: (req) => req.url === '/success' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://illegible.ink', 'https://app.illegible.ink']
    : 'http://localhost:5173',
  methods: ['GET', 'POST'],
  credentials: true
}));

// PostgreSQL setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('PostgreSQL error:', err);
  process.exit(1);
});

// Create tables
pool.query(`
  CREATE TABLE IF NOT EXISTS purchases (
    userId TEXT,
    setId TEXT,
    purchaseDate BIGINT,
    PRIMARY KEY (userId, setId)
  );
  CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
  );
  CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
`).catch((err) => {
  console.error('Table creation error:', err);
  process.exit(1);
});

// Session middleware
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

// PKCE utilities
const generateCodeVerifier = () => crypto.randomBytes(32).toString('base64url');
const generateCodeChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const generateState = () => crypto.randomBytes(16).toString('hex');

async function retry(fn, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.statusCode || (error.response && error.response.status);
      if (status === 429) {
        const retryAfter = parseInt(error.headers?.['retry-after']) * 1000 || delay * attempt;
        await new Promise(resolve => setTimeout(resolve, retryAfter));
      } else if (status === 401) {
        throw new Error('Authentication expired');
      } else if (status >= 400 && status < 500) {
        throw error;
      } else if (attempt === retries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
}

const requireAuth = async (req, res, next) => {
  if (!spotifyApi.getAccessToken()) {
    return req.method === 'POST'
      ? res.status(401).json({ code: 401, message: 'Authentication required' })
      : res.redirect('/login');
  }
  try {
    await retry(() => spotifyApi.getMe());
    next();
  } catch (error) {
    spotifyApi.setAccessToken(null);
    return req.method === 'POST'
      ? res.status(401).json({ code: 401, message: 'Authentication required' })
      : res.redirect('/login');
  }
};

app.get('/', (req, res) => res.render('launch'));

app.get('/playlists', requireAuth, async (req, res) => {
  try {
    const user = await retry(() => spotifyApi.getMe());
    const userId = user.body.id;

    const client = await pool.connect();
    let purchases;
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      purchases = (await client.query('SELECT setid FROM purchases WHERE userId = $1', [userId])).rows;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const purchasedSets = new Set(purchases.map(p => p.setid));

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
    console.error('Playlists error:', error);
    res.status(500).json({ code: 500, message: 'Internal server error' });
  }
});

async function getAlbumArts(playlists) {
  const albumArts = [];
  const fallbackImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

  for (const playlistId of playlists) {
    try {
      const playlist = await retry(() => spotifyApi.getPlaylist(playlistId));
      for (const item of playlist.body.tracks.items.slice(0, 4)) {
        const art = item.track?.album?.images[0]?.url;
        if (art && albumArts.length < 4) albumArts.push(art);
        if (albumArts.length === 4) break;
      }
      if (albumArts.length === 4) break;
    } catch (err) {}
  }

  while (albumArts.length < 4) albumArts.push(fallbackImage);
  return albumArts;
}

app.get('/login', (req, res) => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  req.session.codeVerifier = codeVerifier;
  req.session.state = state;

  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scopes.join(' '),
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })}`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/');
  if (!code || !state || state !== req.session.state || !req.session.codeVerifier) {
    return res.status(400).json({ code: 400, message: 'Invalid or expired state' });
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        code_verifier: req.session.codeVerifier
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error_description || 'Token exchange failed');
    }

    const data = await response.json();
    spotifyApi.setAccessToken(data.access_token);
    spotifyApi.setRefreshToken(data.refresh_token || '');
    req.session.accessToken = data.access_token;
    req.session.refreshToken = data.refresh_token;
    res.redirect('/playlists');
  } catch (error) {
    console.error('Callback error:', error);
    res.status(400).json({ code: 400, message: 'Authentication failed' });
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
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&setId=${setId}&userId=${user.body.id}`,
      cancel_url: `${process.env.BASE_URL}/playlists`
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ code: 500, message: 'Checkout failed' });
  }
});

app.get('/success', async (req, res) => {
  const { session_id, setId, userId } = req.query;
  if (!playlistSets[setId] || !session_id || !userId) return res.redirect('/playlists');

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      await pool.query(
        'INSERT INTO purchases (userId, setId, purchaseDate) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [userId, setId, Date.now()]
      );
    }
    res.redirect(`/playlists?highlight=${setId}`);
  } catch (error) {
    console.error('Success error:', error);
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
      const purchase = (await pool.query('SELECT setid FROM purchases WHERE userId = $1 AND setId = $2', [userId, setId])).rows[0];
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
    console.error('Save error:', error);
    const status = error.statusCode || 500;
    res.status(status).json({
      code: status,
      message: status === 429 ? 'Rate limit exceeded, please try again later' : 'Failed to save curated playlists'
    });
  }
});

app.get('/data-request', requireAuth, async (req, res) => {
  try {
    const user = await retry(() => spotifyApi.getMe());
    const purchases = (await pool.query('SELECT setid, purchaseDate FROM purchases WHERE userId = $1', [user.body.id])).rows;
    res.json({ userId: user.body.id, purchases });
  } catch (error) {
    console.error('Data request error:', error);
    res.status(500).json({ code: 500, message: 'Failed to retrieve data' });
  }
});

app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));

app.get('/logout', (req, res) => {
  spotifyApi.setAccessToken(null);
  req.session.destroy(() => res.redirect('/'));
});

app.post('/delete-data', (req, res) => {
  if (spotifyApi.getAccessToken()) {
    pool.query('DELETE FROM purchases WHERE userId = $1', [spotifyApi.getAccessToken()], (err) => {
      if (err) console.error('Delete purchases error:', err);
    });
  }
  spotifyApi.setAccessToken(null);
  req.session.destroy(() => res.redirect('/?success=data-deleted'));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ code: 500, message: 'Internal server error' });
});

const PORT = process.env.PORT || 5173;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;