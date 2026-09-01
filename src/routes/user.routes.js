const express = require('express');
const router = express.Router();
const UserController = require('../controllers/user.controller');

// GET    /api/users
router.get('/', UserController.getAll);

// GET    /api/users/:id
router.get('/:id', UserController.getOne);

// POST   /api/users
router.post('/', UserController.create);

// PUT    /api/users/:id
router.put('/:id', UserController.update);

// DELETE /api/users/:id
router.delete('/:id', UserController.remove);

module.exports = router;
