const express = require('express');
const router = express.Router();
const SiteUserController = require('../controllers/siteUser.controller');
const protect = require('../middlewares/protect'); // admin JWT guard

/**
 * All /api/user-master routes are protected — only logged-in admins
 * can create, read, update, or delete site-users.
 */
router.use(protect);

// GET  /api/user-master/modules  — list available module access options
// Must be declared before /:id so "modules" is not treated as an id
router.get('/modules', SiteUserController.getModules);

// GET    /api/user-master          — list all site-users
router.get('/', SiteUserController.getAll);

// GET    /api/user-master/:id      — get a single site-user
router.get('/:id', SiteUserController.getOne);

// POST   /api/user-master          — create a site-user
// Body:  { fullname, email, password, moduleAccess: string[] }
router.post('/', SiteUserController.create);

// PUT    /api/user-master/:id      — update a site-user
// Body:  any subset of { fullname, email, password, moduleAccess, is_active }
router.put('/:id', SiteUserController.update);

// DELETE /api/user-master/:id      — delete a site-user
router.delete('/:id', SiteUserController.remove);

module.exports = router;
