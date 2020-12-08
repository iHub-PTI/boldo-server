import 'dotenv/config'

import mongoose from 'mongoose'

import CoreAppointment from '../src/models/CoreAppointment'

export const archiveAppointments = async () => {
  await mongoose.connect(`${process.env.MONGODB_URI}`, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useFindAndModify: false,
    useUnifiedTopology: true,
  })

  const eightHoursAgo = new Date()
  eightHoursAgo.setHours(eightHoursAgo.getHours() - 8)

  try {
    const res = await CoreAppointment.updateMany(
      { date: { $lte: eightHoursAgo }, status: { $ne: 'locked' } },
      { status: 'locked' }
    )
    console.log('🏛 ✅ DAILY ARCHIVE ORDERS TASK RESULTS: ', res)
  } catch (err) {
    console.log(err)
  }
  mongoose.disconnect()
}

if (require.main === module) {
  archiveAppointments()
}
