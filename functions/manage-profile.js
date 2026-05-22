const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { maxPoolSize: 10, minPoolSize: 1, maxIdleTimeMS: 30000 });

const CV_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { userId, action, profile } = body;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required' }) };
  }

  try {
    await client.connect();
    const db = client.db('cverve');
    const profiles = db.collection('user_profiles');

    // ── GET profile ──────────────────────────────────────────────────────────
    if (action === 'get') {
      const existing = await profiles.findOne({ userId });
      if (!existing) {
        return { statusCode: 200, body: JSON.stringify({ profile: null }) };
      }
      const { _id, ...profileData } = existing;
      return { statusCode: 200, body: JSON.stringify({ profile: profileData }) };
    }

    // ── SAVE / UPDATE profile ────────────────────────────────────────────────
    if (action === 'save') {
      if (!profile || typeof profile !== 'object') {
        return { statusCode: 400, body: JSON.stringify({ error: 'profile object required' }) };
      }

      const { fullName, phone, email, address, cvText, cvFilename, cvPdfBase64 } = profile;

      if (!fullName || !phone || !email || !address) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields (fullName, phone, email, address)' }) };
      }

      // ── CV PDF validation ────────────────────────────────────────────────
      let cvPdfToStore = null;

      if (cvPdfBase64 !== undefined && cvPdfBase64 !== null && cvPdfBase64 !== '') {
        // Enforce PDF-only: base64 for a PDF always starts with "JVBERi0" (the %PDF- magic bytes in base64)
        if (!cvPdfBase64.startsWith('JVBERi0')) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Only PDF files are accepted for CV storage.' })
          };
        }

        // Check size: base64 length * 0.75 ≈ original byte size
        const approxBytes = Math.ceil(cvPdfBase64.length * 0.75);
        if (approxBytes > CV_MAX_BYTES) {
          return {
            statusCode: 413,
            body: JSON.stringify({
              error: 'CV file exceeds the 2 MB limit and was not saved. Your profile details were saved without the CV file.'
            })
          };
        }

        cvPdfToStore = cvPdfBase64;
      }

      // Fetch existing stored PDF if no new one is being provided (preserve it)
      let existingCvPdf = null;
      if (cvPdfToStore === null && cvPdfBase64 === undefined) {
        const existing = await profiles.findOne({ userId }, { projection: { cvPdfBase64: 1 } });
        existingCvPdf = existing ? existing.cvPdfBase64 || null : null;
      }

      const updateDoc = {
        userId,
        fullName,
        phone,
        email,
        address,
        cvText: cvText || null,
        cvFilename: cvFilename || null,
        // store new PDF if provided; keep existing if not touched; clear if explicitly null
        cvPdfBase64: cvPdfToStore !== null ? cvPdfToStore : (cvPdfBase64 === null ? null : existingCvPdf),
        updatedAt: new Date()
      };

      await profiles.findOneAndUpdate(
        { userId },
        { $set: updateDoc },
        { upsert: true, returnDocument: 'after' }
      );

      // Don't echo the PDF bytes back — return a flag instead so the client knows if a PDF is stored
      const responseProfile = { ...updateDoc, hasCvPdf: !!updateDoc.cvPdfBase64 };
      delete responseProfile.cvPdfBase64;

      return { statusCode: 200, body: JSON.stringify({ success: true, profile: responseProfile }) };
    }

    // ── GET CV PDF (separate action to avoid large payloads on normal profile loads) ──
    if (action === 'get-cv-pdf') {
      const existing = await profiles.findOne({ userId }, { projection: { cvPdfBase64: 1, cvFilename: 1 } });
      if (!existing || !existing.cvPdfBase64) {
        return { statusCode: 404, body: JSON.stringify({ error: 'No stored CV PDF found.' }) };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ cvPdfBase64: existing.cvPdfBase64, cvFilename: existing.cvFilename || null })
      };
    }

    // ── DELETE profile ───────────────────────────────────────────────────────
    if (action === 'delete') {
      await profiles.deleteOne({ userId });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action. Use get, save, get-cv-pdf, or delete.' }) };
  } catch (err) {
    console.error('manage-profile error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};