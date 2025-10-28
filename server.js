const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const state = require('./lib/state');
const newsRoutes = require('./routes/news');
const aiActivityLog = require('./routes/safezone/aiActivityLog');
const systemHealth = require('./routes/system/health');
const monitorHub = require('./routes/system/monitorHub');
const reportsExport = require('./routes/reports/export');

dotenv.config(); // Load environment variables from .env file

const app = express();
const server = http.createServer(app);

// Middleware
app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'https://newspulse-frontend-main.vercel.app',
      'https://admin.newspulse.co.in',
    ],
    credentials: true, // Optional: if you plan to use cookies or auth headers
  }),
);

app.use(express.json()); // Parse incoming JSON requests

// MongoDB Connection (resilient: don't crash app if DB is temporarily unreachable)
const rawMongoUri = (process.env.MONGO_URI || '').trim();
const connectWithRetry = async (delayMs = 30000) => {
  const uri = (process.env.MONGO_URI || '').trim();
  if (!uri) {
    console.warn('⚠️  MONGO_URI not set. API will run with limited functionality.');
    return;
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    const preview = uri.length > 12 ? uri.slice(0, 12) + '…' : uri;
    console.error(`❌ Invalid MONGO_URI scheme: "${preview}". Expected it to start with "mongodb://" or "mongodb+srv://". Will retry.`);
    setTimeout(() => connectWithRetry(delayMs), delayMs);
    return;
  }
  try {
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error (will retry):', err?.message || err);
    setTimeout(() => connectWithRetry(delayMs), delayMs);
  }
};
connectWithRetry();

// Simple homepage route
app.get('/', (req, res) => {
  res.send('🎉 News Pulse Backend is Live!');
});

// API Routes
app.use('/api/news', newsRoutes);
app.use('/api/ai-activity-log', aiActivityLog);
app.use('/api/system/health', systemHealth);
// Optional compatibility path
app.use('/api/health', systemHealth);
app.use('/api/system/monitor-hub', monitorHub);
app.use('/api/reports/export', reportsExport);

// Socket.IO for realtime active user count
const io = new Server(server, {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  cors: {
    origin: [
      'http://localhost:3000',
      'https://newspulse-frontend-main.vercel.app',
      'https://admin.newspulse.co.in',
    ],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  state.activeUsers = (state.activeUsers || 0) + 1;
  io.emit('activeUserCount', state.activeUsers);

  socket.on('disconnect', () => {
    state.activeUsers = Math.max(0, (state.activeUsers || 0) - 1);
    io.emit('activeUserCount', state.activeUsers);
  });
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res
    .status(500)
    .json({ message: 'Something went wrong, please try again later.' });
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
