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

// Security & utility middleware
app.use(helmet());
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan('dev'));
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
