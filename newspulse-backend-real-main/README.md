# NewsPulse Backend

Express.js backend API for NewsPulse news management platform.

## Quick Start

### 1. Install Dependencies
```powershell
npm install
```

### 2. Configure MongoDB

**Option A: Local MongoDB (easiest for development)**
```powershell
# Install MongoDB locally, or run via Docker:
docker run --name newspulse-mongo -p 27017:27017 -d mongo:6

# Update .env (or create from .env.example):
MONGODB_URI=mongodb://127.0.0.1:27017/newsdb
```

**Option B: MongoDB Atlas (recommended for production)**
1. Get your connection string from [MongoDB Atlas](https://cloud.mongodb.com/)
   - Navigate to: Your Cluster → Connect → Drivers
   - Copy the Node.js driver connection string
2. Update `.env`:
   ```
   MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/newsdb?retryWrites=true&w=majority
   ```

### 3. Run the Server

**Development mode (with auto-reload):**
```powershell
npm run dev
```

**Production mode:**
```powershell
npm start
```

The server will start on `http://localhost:5000`

## API Endpoints


## Project Structure

```
newspulse-backend-real-main/
## Render deployment

Service URL: https://newspulse-backend-real.onrender.com

- Working directory/rootDir: `newspulse-backend-real-main` (this folder contains `server.js` and `routes/`).
- Ensure Render environment variables are set:
   - `FOUNDER_EMAIL`
   - `FOUNDER_PASSWORD`
   - `FOUNDER_NAME` (optional)
   - `FOUNDER_ID` (optional)
   - `MONGODB_URI` (production database connection string)

Admin UI (Vercel) calls these endpoints (no `/api` prefix):
- `POST /admin/login`
- `GET /admin-auth/session`
- `GET /system/ai-training-info`
- `GET /admin/health` (optional)

After deploying on Render, verify with:
```powershell
curl https://newspulse-backend-real.onrender.com/admin/health
curl -X POST -H "Content-Type: application/json" \
   -d '{"email":"<FOUNDER_EMAIL>","password":"<FOUNDER_PASSWORD>"}' \
   https://newspulse-backend-real.onrender.com/admin/login
```
├── server.js           # Main application entry point
├── routes/             # API route definitions
├── controllers/        # Request handlers
├── models/             # Mongoose schemas
├── lib/                # Utilities and helpers
├── .env                # Environment variables (create from .env.example)
└── package.json        # Dependencies and scripts
```

## Troubleshooting

### MongoDB Connection Issues

**Error: `querySrv ENOTFOUND`**
- Your Atlas cluster hostname is incorrect or DNS cannot resolve it
- Verify your connection string in MongoDB Atlas
- Try a non-SRV connection string (toggle off SRV in Atlas UI)
- Or use local MongoDB as a fallback

**Server crashes on startup**
- The app now continues running even if MongoDB fails to connect
- Check logs for the specific error message
- Verify your `.env` file exists and has a valid `MONGODB_URI`

### Module Not Found Errors

If running from the wrong directory:
```powershell
# Make sure you're in the correct folder:
cd "C:\Users\Kiran\OneDrive\Desktop\website\newspulse-backend-real-main\newspulse-backend-real-main"
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017/newsdb` |
| `PORT` | Server port | `5000` |
| `FOUNDER_EMAIL` | Admin login email | `founder@example.com` |
| `FOUNDER_PASSWORD` | Admin login password | `replace-me` |
| `FOUNDER_NAME` | Admin display name | `NewsPulse Founder` |
| `FOUNDER_ID` | Admin user id | `founder-1` |
| `NODE_ENV` | Environment indicator | `development` |

## CORS Configuration

The server allows requests from:
- `http://localhost:3000` (local development)
- `https://newspulse-frontend-main.vercel.app` (production)

To add more origins, edit the `cors` configuration in `server.js`.

## Security Notes

- **Never commit `.env` to version control** - it contains credentials
- Rotate your MongoDB password if it was exposed
- Use environment variables in production (e.g., Vercel, Railway, Render)
