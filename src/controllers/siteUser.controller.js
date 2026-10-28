const bcrypt = require('bcryptjs');
const SiteUserModel = require('../models/siteUser.model');

const SiteUserController = {
  /**
   * GET /api/user-master
   * Returns all site-users (admin only).
   */
  async getAll(req, res, next) {
    try {
      const users = await SiteUserModel.findAll();
      return res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/user-master/:userId
   * Returns a single site-user (admin only).
   * Example: GET /api/user-master/tbusr001
   */
  async getOne(req, res, next) {
    try {
      const user = await SiteUserModel.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'Site user not found.' });
      }
      return res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/user-master
   * Create a new site-user (admin only).
   * Body: { fullname, email, password, moduleAccess: string[] }
   * The userId (tbusr001, tbusr002, …) is generated automatically.
   */
  async create(req, res, next) {
    try {
      const {
        fullname,
        email,
        password,
        moduleAccess,
        phone,
        role,
        department,
        designation,
      } = req.body || {};

      // --- Validation ---
      if (!fullname || typeof fullname !== 'string' || !fullname.trim()) {
        return res.status(400).json({
          success: false,
          message: 'fullname is required.',
        });
      }

      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({
          success: false,
          message: 'email is required.',
        });
      }

      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'password is required and must be at least 6 characters.',
        });
      }

      if (!Array.isArray(moduleAccess) || moduleAccess.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one module access value must be selected.',
        });
      }

      // Validate each module value against the allowed list
      const invalidModules = moduleAccess.filter(
        (m) => !SiteUserModel.MODULES.includes(m)
      );
      if (invalidModules.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid module(s): ${invalidModules.join(', ')}. Allowed: ${SiteUserModel.MODULES.join(', ')}.`,
        });
      }

      // Check email uniqueness (case-insensitive)
      const normalizedEmail = email.toLowerCase().trim();
      const existing = await SiteUserModel.findByEmail(normalizedEmail);
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A site user with this email already exists.',
        });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const user = await SiteUserModel.create({
        fullname: fullname.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        moduleAccess,
        role: role || 'employee',
        phone: phone || null,
        department: department || null,
        designation: designation || null,
        mustChangePassword: 1, // PRD mandatory first-login password change
      });

      return res.status(201).json({
        success: true,
        message: 'Site user created successfully.',
        data: user,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          message: 'A site user with this email already exists.',
        });
      }
      next(err);
    }
  },

  /**
   * PUT /api/user-master/:userId
   * Update a site-user (admin only).
   * Example: PUT /api/user-master/TBS001
   * Body: any subset of { fullname, email, password, moduleAccess, is_active, phone, role, department, designation, must_change_password }
   */
  async update(req, res, next) {
    try {
      const {
        fullname,
        email,
        password,
        moduleAccess,
        is_active,
        must_change_password,
        phone,
        role,
        department,
        designation,
      } = req.body || {};
      const { userId } = req.params;

      // Validate moduleAccess if provided
      if (moduleAccess !== undefined) {
        if (!Array.isArray(moduleAccess) || moduleAccess.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'moduleAccess must be a non-empty array.',
          });
        }
        const invalidModules = moduleAccess.filter(
          (m) => !SiteUserModel.MODULES.includes(m)
        );
        if (invalidModules.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid module(s): ${invalidModules.join(', ')}.`,
          });
        }
      }

      // If email is changing, ensure it's not already taken by another user
      if (email !== undefined) {
        const normalizedEmail = email.toLowerCase().trim();
        const existing = await SiteUserModel.findByEmail(normalizedEmail);
        if (existing && existing.user_id !== userId) {
          return res.status(409).json({
            success: false,
            message: 'This email is already in use by another site user.',
          });
        }
      }

      // Hash new password if provided
      let hashedPassword;
      if (password) {
        hashedPassword = await bcrypt.hash(password, 12);
      }

      const updated = await SiteUserModel.update(userId, {
        fullname,
        email,
        password: hashedPassword,
        moduleAccess,
        is_active,
        must_change_password,
        phone,
        role,
        department,
        designation,
      });

      if (!updated) {
        return res.status(404).json({ success: false, message: 'Site user not found.' });
      }

      return res.json({ success: true, message: 'Site user updated successfully.' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          message: 'This email is already in use by another site user.',
        });
      }
      next(err);
    }
  },

  /**
   * DELETE /api/user-master/:userId
   * Delete a site-user (admin only).
   * Example: DELETE /api/user-master/tbusr001
   */
  async remove(req, res, next) {
    try {
      const deleted = await SiteUserModel.remove(req.params.userId);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Site user not found.' });
      }
      return res.json({ success: true, message: 'Site user deleted successfully.' });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/user-master/modules
   * Returns the full list of available module access options.
   */
  async getModules(req, res) {
    return res.json({ success: true, data: SiteUserModel.MODULES });
  },
};

module.exports = SiteUserController;
