const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/auth.controller');
const protect = require('../middlewares/protect');

// POST  /api/auth/login   — public
router.post('/login', AuthController.login);

// POST  /api/auth/logout  — public (client discards token)
router.post('/logout', AuthController.logout);

// GET   /api/auth/me      — protected (valid JWT required)
router.get('/me', protect, AuthController.me);

module.exports = router;
