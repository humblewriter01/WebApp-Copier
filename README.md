# 🌐 Telegram Signal Copier - Web Application

**Production-grade web application** where Telegram sessions run on user devices while trading logic executes on the server.

---

## 🏗️ Architecture

```
USER DEVICE (Browser/Mobile)
  ↓ WebSocket + REST API
SERVER (VPS)
  ├── Express.js API
  ├── Socket.io (Real-time)
  ├── MongoDB (Data)
  ├── Redis (Cache/Sessions)
  └── MetaApi (Trading)
```

### ✨ Key Features

- 🔐 **User Authentication** - JWT-based secure login
- 📱 **Device-Based Telegram** - Sessions run on user devices
- 🔄 **Real-Time Updates** - WebSocket for instant notifications
- 💼 **Multi-Account** - Manage multiple MT4/MT5 accounts
- ⚙️ **Per-User Settings** - Individual risk management
- 📊 **Live Dashboard** - Real-time statistics & charts
- 🗺️ **Symbol Mapping** - Broker-specific symbol names
- 🔔 **Notifications** - Optional Telegram bot alerts

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- MongoDB
- Redis
- MetaApi account
- Telegram API credentials

### Installation

```bash
# Clone repository
git clone <your-repo>
cd telegram-copier-webapp

# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install

# Setup environment
cp .env.example .env
nano .env  # Add your credentials
```

### Development

```bash
# Terminal 1 - Start server
cd server
npm run dev

# Terminal 2 - Start client
cd client
npm run dev

# Terminal 3 - Start MongoDB
mongod

# Terminal 4 - Start Redis
redis-server
```

Access:
- Frontend: http://localhost:3000
- Backend: http://localhost:5000
- API Docs: http://localhost:5000/docs

---

## 🐳 Docker Deployment

```bash
# Configure environment
cp .env.example .env
nano .env

# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

Services:
- Frontend: http://localhost:3000
- Backend: http://localhost:5000
- MongoDB: localhost:27017
- Redis: localhost:6379

---

## 📁 Project Structure

```
telegram-copier-webapp/
├── server/                 # Backend (Node.js + Express)
│   ├── api/               # REST endpoints
│   ├── websocket/         # Socket.io handlers
│   ├── services/          # Business logic
│   ├── models/            # Database models
│   ├── middleware/        # Express middleware
│   └── metaapi/          # Trading engine
│
├── client/                # Frontend (React)
│   ├── src/
│   │   ├── pages/        # Page components
│   │   ├── components/   # Reusable components
│   │   ├── hooks/        # Custom React hooks
│   │   ├── services/     # API clients
│   │   └── store/        # State management
│   └── public/
│
└── docker/                # Docker configuration
```

---

## 🔑 Configuration

### Server (.env)

```env
# Database
MONGODB_URI=mongodb://localhost:27017/telegram-copier
REDIS_URL=redis://localhost:6379

# Authentication
JWT_SECRET=your_secret_key

# Telegram
API_ID=12345678
API_HASH=your_hash

# MetaApi
META_API_TOKEN=your_token

# Client
CLIENT_URL=http://localhost:3000
```

### Client (.env)

```env
VITE_API_URL=http://localhost:5000
```

---

## 📡 API Endpoints

### Authentication

```
POST   /api/auth/register    - Register new user
POST   /api/auth/login       - Login
GET    /api/auth/verify      - Verify token
POST   /api/auth/logout      - Logout
```

### Users

```
GET    /api/users/profile    - Get profile
PUT    /api/users/profile    - Update profile
DELETE /api/users/account    - Delete account
```

### Trading Accounts

```
GET    /api/accounts         - List accounts
POST   /api/accounts         - Add account
PUT    /api/accounts/:id     - Update account
DELETE /api/accounts/:id     - Remove account
```

### Channels

```
GET    /api/channels         - List channels
POST   /api/channels         - Subscribe channel
DELETE /api/channels/:id     - Unsubscribe
```

### Settings

```
GET    /api/settings         - Get settings
PUT    /api/settings         - Update settings
```

### Signals

```
GET    /api/signals          - Signal history
GET    /api/signals/:id      - Get signal
```

### Trades

```
GET    /api/trades           - Trade history
GET    /api/trades/:id       - Get trade
GET    /api/trades/stats     - Get statistics
```

---

## 🔌 WebSocket Events

### Client → Server

```javascript
// Telegram
telegram:requestCode    - Request verification code
telegram:login          - Complete login
telegram:restore        - Restore session
telegram:getChannels    - Get joined channels
telegram:subscribeChannel - Subscribe to channel
telegram:disconnect     - Disconnect Telegram

// Trading
trading:executeSignal   - Execute trade
trading:closePosition   - Close position
trading:closeAll        - Close all positions

// Dashboard
dashboard:getData       - Get initial data
dashboard:subscribe     - Subscribe to updates
```

### Server → Client

```javascript
// Telegram
telegram:codeRequested  - Code sent
telegram:loginSuccess   - Login successful
telegram:restored       - Session restored
telegram:channels       - Channel list
telegram:error          - Error occurred

// Signals
signal:received         - New signal
signal:parsed           - Signal parsed
signal:executed         - Trade executed

// Trading
trade:opened            - Position opened
trade:closed            - Position closed
trade:updated           - Position updated

// Dashboard
dashboard:stats         - Statistics update
dashboard:accounts      - Accounts update
```

---

## 🎯 User Flow

### 1. Registration

```
User → Register → Email Verification → Login
```

### 2. Telegram Connection

```
User → Enter Phone → Receive Code → Enter Code → Connected
```

### 3. Add Trading Account

```
User → Add Account → Enter MetaApi Credentials → Verify → Active
```

### 4. Subscribe to Channels

```
User → View Channels → Select Channel → Subscribe → Active
```

### 5. Configure Settings

```
User → Settings → Adjust Parameters → Save → Applied
```

### 6. Monitor Trading

```
Dashboard → Real-time Updates → Signals → Trades → Statistics
```

---

## 🔒 Security

### Authentication

- JWT tokens (7-day expiry)
- Bcrypt password hashing (10 rounds)
- HTTP-only cookies for web
- Token refresh on API calls

### WebSocket

- JWT-based authentication
- Per-user rooms
- Rate limiting
- Connection validation

### API

- Helmet.js security headers
- CORS configuration
- Rate limiting (100 req/15min)
- Input validation
- SQL injection protection

### Production

```bash
# Generate strong JWT secret
openssl rand -base64 32

# Setup SSL certificates
certbot --nginx -d yourdomain.com

# Configure firewall
ufw allow 22,80,443/tcp
```

---

## 📊 Monitoring

### Health Check

```bash
curl http://localhost:5000/health
```

Response:
```json
{
  "status": "OK",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "uptime": 3600
}
```

### Logs

```bash
# Server logs
pm2 logs copier-server

# Docker logs
docker-compose logs -f server

# MongoDB logs
docker-compose logs -f mongo
```

### Metrics

- Active users
- Open connections
- Trade volume
- API response time
- Database queries

---

## 🚨 Troubleshooting

### WebSocket Not Connecting

```bash
# Check CORS configuration
CLIENT_URL=http://yourdomain.com

# Verify token
curl -H "Authorization: Bearer <token>" http://localhost:5000/api/auth/verify
```

### Telegram Session Lost

```
User → Settings → Telegram → Reconnect
```

### Database Connection Failed

```bash
# Check MongoDB
systemctl status mongod

# Check connection string
MONGODB_URI=mongodb://localhost:27017/telegram-copier
```

### Redis Connection Failed

```bash
# Check Redis
redis-cli ping

# Check connection string
REDIS_URL=redis://localhost:6379
```

---

## 🔄 Updates

```bash
# Pull latest changes
git pull origin main

# Server updates
cd server
npm install
pm2 restart copier-server

# Client updates
cd client
npm install
npm run build

# Database migrations (if any)
npm run migrate
```

---

## 📦 Production Deployment

### VPS Setup

```bash
# Install dependencies
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs mongodb redis-server nginx

# Install PM2
sudo npm install -g pm2

# Clone project
git clone <repo> telegram-copier
cd telegram-copier

# Setup server
cd server
npm install
cp .env.example .env
nano .env

# Setup client
cd ../client
npm install
npm run build

# Start with PM2
pm2 start server/index.js --name copier-server
pm2 startup
pm2 save

# Configure Nginx
sudo nano /etc/nginx/sites-available/telegram-copier
sudo ln -s /etc/nginx/sites-available/telegram-copier /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### SSL Certificate

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## 📞 Support

- Issues: [GitHub Issues](https://github.com/your-repo/issues)

---

## ⚠️ Disclaimer

**Trading involves risk. This software is provided "as is" without warranty. Always test on demo accounts first.**

---

Built with ❤️ for traders worldwide 🌍

*Humble-writer ✍️*
