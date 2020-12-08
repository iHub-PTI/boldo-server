# Data

### Archive Data

To lock all appointments that are 8 hours in the past, run:

```
npm run archiveAppointmentsDev

// or in Production
npm run archiveAppointments
```

This script should be scheduled to run every minute or hour

### Migrate Data

Migrate Data to keep the DB up-to-date.

#### Create a Migration

Migrations are single files that export a function called migration.
They go into the `./scripts/migrations` folder.
Used like this:

```javascript
export const migration = async db => {
  console.log('Converting all phoneNumbers to Strings')
  await db.collection('appointments').find({}) //and so on...
  console.log('done')
}
```

You could also use mongoose Documents in here (e.g. `Appointment.create(...)`)

The suggested way of naming is `<number>-<description>.ts`. E.g. `1-update-appointment-date.ts`. Migrations will be executed in order of the number they start with if available.

#### Run a migration

Run all migrations in the `./scripts/migrations` folder:

```
npm run migrateDev
// or in production
npm run migrate
```

Run all scripts that start with number 1.

```
npm run migrateDev 1
// or in production
npm run migrate 1
```

This would execute `1-name.ts` but not `10-name.ts`
