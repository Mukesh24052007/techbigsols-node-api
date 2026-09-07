const express = require('express');
const router = express.Router();
const SiteAuthController = require('../controllers/siteAuth.controller');
const siteUserProtect = require('../middlewares/siteUserProtect');

// POST  /api/site-auth/login   — public, authenticates a site-user
router.post('/login', SiteAuthController.login);

// POST  /api/site-auth/logout  — public (client discards token)
router.post('/logout', SiteAuthController.logout);

// GET   /api/site-auth/me      — protected (valid site-user JWT required)
router.get('/me', siteUserProtect, SiteAuthController.me);

module.exports = router;
