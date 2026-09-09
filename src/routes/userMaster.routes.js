const express = require('express');
const router = express.Router();
const SiteUserController = require('../controllers/siteUser.controller');
const protect = require('../middlewares/protect'); // admin JWT guard

/**
 * All /api/user-master routes are protected — only logged-in admins
 * can create, read, update, or delete site-users.
 */
router.use(protect);

// GET  /api/user-master/modules       — list available module access options
// Must be declared before /:userId so "modules" is not treated as a userId
router.get('/modules', SiteUserController.getModules);

// GET    /api/user-master             — list all site-users
router.get('/', SiteUserController.getAll);

// GET    /api/user-master/tbusr001    — get a single site-user
router.get('/:userId', SiteUserController.getOne);

// POST   /api/user-master             — create a site-user (userId is auto-generated)
// Body:  { fullname, email, password, moduleAccess: string[] }
router.post('/', SiteUserController.create);

// PUT    /api/user-master/tbusr001    — update a site-user
// Body:  any subset of { fullname, email, password, moduleAccess, is_active }
router.put('/:userId', SiteUserController.update);

// DELETE /api/user-master/tbusr001    — delete a site-user
router.delete('/:userId', SiteUserController.remove);

module.exports = router;
