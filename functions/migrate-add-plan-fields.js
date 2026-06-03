// scripts/migrate-add-plan-fields.js
// Run ONCE against your MongoDB to add plan/usage fields to existing users.
//
// Usage:
//   MONGODB_URI="mongodb+srv://..." node scripts/migrate-add-plan-fields.js
//
// What it does:
//   - For every user who has NO `plan` field: sets plan='free', planExpiry=null, usageCounts={0,0,0}
//   - Users who already have a `plan` field are left untouched.
//   - Safe to re-run: uses $exists check so it never overwrites existing plan data.

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('ERROR: MONGODB_URI environment variable is not set.');
  process.exit(1);
}

async function migrate() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('Connected to MongoDB.');

    const db       = client.db('cverve');
    const usersCol = db.collection('users');

    // Count how many users need migration
    const needsMigration = await usersCol.countDocuments({ plan: { $exists: false } });
    console.log(`Users without plan field: ${needsMigration}`);

    if (needsMigration === 0) {
      console.log('All users already have plan fields. Nothing to do.');
      return;
    }

    // Apply defaults only to users missing the plan field
    const result = await usersCol.updateMany(
      { plan: { $exists: false } },
      {
        $set: {
          plan:            'free',
          planExpiry:      null,
          planActivatedAt: null,
          usageCounts: {
            letters:   0,
            pdfMerges: 0,
            cvBuilds:  0
          }
        }
      }
    );

    console.log(`Migration complete. Updated ${result.modifiedCount} user(s).`);

    // Also add empty notifications array to users missing it
    const notifResult = await usersCol.updateMany(
      { notifications: { $exists: false } },
      { $set: { notifications: [] } }
    );
    if (notifResult.modifiedCount > 0) {
      console.log(`Added notifications array to ${notifResult.modifiedCount} user(s).`);
    }

    // Verify
    const remaining = await usersCol.countDocuments({ plan: { $exists: false } });
    console.log(`Users still missing plan field after migration: ${remaining}`);

  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.close();
    console.log('Connection closed.');
  }
}

migrate();