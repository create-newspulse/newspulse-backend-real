const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const newsRoutes = require('./routes/news');
const aiActivityLog = require('./routes/safezone/aiActivityLog');

dotenv.config(); // Load environment variables from .env file

const app = express();

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
const MONGO_URI = process.env.MONGO_URI;
const connectWithRetry = async (delayMs = 30000) => {
  if (!MONGO_URI) {
    console.warn('⚠️  MONGO_URI not set. API will run with limited functionality.');
    return;
  }
  try {
    await mongoose.connect(MONGO_URI, {
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

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res
    .status(500)
    .json({ message: 'Something went wrong, please try again later.' });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
