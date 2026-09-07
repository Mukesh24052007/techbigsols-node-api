const ProductModel = require('../models/product.model');

const ProductController = {
  // ── GET /api/products ─────────────────────────────────────────────────────
  async getAll(req, res, next) {
    try {
      const products = await ProductModel.findAll();
      res.json({ success: true, data: products });
    } catch (err) {
      next(err);
    }
  },

  // ── GET /api/products/:id ─────────────────────────────────────────────────
  async getOne(req, res, next) {
    try {
      const product = await ProductModel.findById(req.params.id);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
      }
      res.json({ success: true, data: product });
    } catch (err) {
      next(err);
    }
  },

  // ── POST /api/products ────────────────────────────────────────────────────
  async create(req, res, next) {
    try {
      const {
        // Basic information
        name,
        short_description,
        full_description,
        // Specifications
        specifications,
        // Media
        image_url,
        // Pricing & meta
        price,
        category,
        badge,
        rating,
        in_stock,
      } = req.body;

      // Required field validation
      if (!name || !short_description || !full_description || price === undefined) {
        return res.status(400).json({
          success: false,
          message: 'name, short_description, full_description and price are required.',
        });
      }

      // specifications must be an array of { key, value } objects when provided
      if (specifications !== undefined) {
        if (!Array.isArray(specifications)) {
          return res.status(400).json({
            success: false,
            message: 'specifications must be an array of { key, value } objects.',
          });
        }
        const invalid = specifications.some(
          (s) => typeof s.key === 'undefined' || typeof s.value === 'undefined'
        );
        if (invalid) {
          return res.status(400).json({
            success: false,
            message: 'Each specification must have a key and a value.',
          });
        }
      }

      // in_stock accepts true/false/1/0/"yes"/"no"
      let stockValue = 1;
      if (in_stock !== undefined) {
        const normalized = String(in_stock).toLowerCase();
        if (['false', '0', 'no'].includes(normalized)) stockValue = 0;
        else if (['true', '1', 'yes'].includes(normalized)) stockValue = 1;
        else {
          return res.status(400).json({
            success: false,
            message: 'in_stock must be yes/no, true/false, or 1/0.',
          });
        }
      }

      const product = await ProductModel.create({
        name,
        short_description,
        full_description,
        specifications: specifications || [],
        image_url: image_url || null,
        price,
        category: category || null,
        badge: badge || null,
        rating: rating || 0,
        in_stock: stockValue,
      });

      res.status(201).json({ success: true, data: product });
    } catch (err) {
      next(err);
    }
  },

  // ── PUT /api/products/:id ─────────────────────────────────────────────────
  async update(req, res, next) {
    try {
      const {
        name,
        short_description,
        full_description,
        specifications,
        image_url,
        price,
        category,
        badge,
        rating,
        in_stock,
      } = req.body;

      // Validate specifications if provided
      if (specifications !== undefined) {
        if (!Array.isArray(specifications)) {
          return res.status(400).json({
            success: false,
            message: 'specifications must be an array of { key, value } objects.',
          });
        }
        const invalid = specifications.some(
          (s) => typeof s.key === 'undefined' || typeof s.value === 'undefined'
        );
        if (invalid) {
          return res.status(400).json({
            success: false,
            message: 'Each specification must have a key and a value.',
          });
        }
      }

      // Normalise in_stock if provided
      const fields = {
        name,
        short_description,
        full_description,
        specifications,
        image_url,
        price,
        category,
        badge,
        rating,
      };

      if (in_stock !== undefined) {
        const normalized = String(in_stock).toLowerCase();
        if (['false', '0', 'no'].includes(normalized))       fields.in_stock = 0;
        else if (['true', '1', 'yes'].includes(normalized))  fields.in_stock = 1;
        else {
          return res.status(400).json({
            success: false,
            message: 'in_stock must be yes/no, true/false, or 1/0.',
          });
        }
      }

      // Strip undefined keys so the model only updates supplied fields
      Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);

      const updated = await ProductModel.update(req.params.id, fields);
      if (!updated) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
      }

      res.json({ success: true, message: 'Product updated successfully.' });
    } catch (err) {
      next(err);
    }
  },

  // ── DELETE /api/products/:id ──────────────────────────────────────────────
  async remove(req, res, next) {
    try {
      const deleted = await ProductModel.remove(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
      }
      res.json({ success: true, message: 'Product deleted successfully.' });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = ProductController;
