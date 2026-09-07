const express = require('express');
const router = express.Router();
const ProductController = require('../controllers/product.controller');
const protect = require('../middlewares/protect');

// Public — anyone can browse products
router.get('/',     ProductController.getAll);
router.get('/:id',  ProductController.getOne);

// Protected — admin JWT required for write operations
router.post('/',        protect, ProductController.create);
router.put('/:id',      protect, ProductController.update);
router.delete('/:id',   protect, ProductController.remove);

module.exports = router;
