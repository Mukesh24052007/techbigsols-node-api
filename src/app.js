const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const healthRoutes = require('./routes/health.routes');
const userRoutes = require('./routes/user.routes');
const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const userMasterRoutes = require('./routes/userMaster.routes');
const siteAuthRoutes = require('./routes/siteAuth.routes');
const { notFound, errorHandler } = require('./middlewares/error.middleware');

const app = express();

// Build allowed-origins list from env (comma-separated) with local fallback
const rawOrigins = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
const allowedOrigins = rawOrigins.split(',').map((o) => o.trim()).filter(Boolean);

// Security & utility middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server / curl requests (no Origin header)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/users', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/user-master', userMasterRoutes);   // admin-managed site-users
app.use('/api/site-auth', siteAuthRoutes);        // site-user login portal

// Error handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;
