const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const port = 3001;

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const stockfishDir = path.join(rootDir, 'node_modules', 'stockfish', 'bin');
const books = {
  white: path.join(dataDir, 'white.pgn'),
  black: path.join(dataDir, 'black.pgn'),
};

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/stockfish', express.static(stockfishDir));

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  await Promise.all(
    Object.values(books).map(async (bookPath) => {
      try {
        await fs.access(bookPath);
      } catch {
        await fs.writeFile(bookPath, '', 'utf8');
      }
    }),
  );
}

function assertSide(side) {
  if (side !== 'white' && side !== 'black') {
    const err = new Error('Invalid side. Use white or black.');
    err.statusCode = 400;
    throw err;
  }
}

app.get('/api/book/:side', async (req, res, next) => {
  try {
    const { side } = req.params;
    assertSide(side);
    const pgn = await fs.readFile(books[side], 'utf8');
    res.json({ side, pgn });
  } catch (error) {
    next(error);
  }
});

app.put('/api/book/:side', async (req, res, next) => {
  try {
    const { side } = req.params;
    const { pgn } = req.body;
    assertSide(side);
    if (typeof pgn !== 'string') {
      res.status(400).json({ error: 'Body must include `pgn` string.' });
      return;
    }
    await fs.writeFile(books[side], pgn, 'utf8');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/lichess', async (req, res, next) => {
  try {
    const source = req.query.source === 'masters' ? 'masters' : 'lichess';
    const endpoint = new URL(`https://explorer.lichess.ovh/${source}`);
    const allowedParams = [
      'fen',
      'play',
      'speeds',
      'ratings',
      'since',
      'until',
      'moves',
      'variant',
      'topGames',
      'recentGames',
      'history',
    ];
    for (const key of allowedParams) {
      const value = req.query[key];
      if (typeof value === 'string' && value.trim()) {
        endpoint.searchParams.set(key, value);
      }
    }
    if (!endpoint.searchParams.has('variant')) endpoint.searchParams.set('variant', 'standard');
    if (!endpoint.searchParams.has('moves')) endpoint.searchParams.set('moves', '12');

    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      res.status(response.status).json({ error: text || 'Lichess explorer request failed.' });
      return;
    }

    const payload = await response.json();
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 500;
  res.status(status).json({
    error: error.message || 'Unexpected server error',
  });
});

ensureDataFiles()
  .then(() => {
    app.listen(port, () => {
      console.log(`Backend listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start backend:', error);
    process.exit(1);
  });
