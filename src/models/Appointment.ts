import mongoose, { Schema, Document } from 'mongoose'

// ////////////////////////////////////////////////////////////////////////////
// !!ATTENTION!! mongoose Appointments getters return id instead of _id !!
// ////////////////////////////////////////////////////////////////////////////

export interface IAppointment extends Document {
  name: string
  start: Date
  end: Date
  appointmentType: "A" | "V" | "E"
  description: string
  doctorId: string
  type: 'PrivateEvent'
  idOrganization: String
}

const AppointmentSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    //A:Ambulatory V:Virtual E:Doctor's Events
    appointmentType: { type: String, enum: ['A', 'V', "E"], required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    description: String,
    doctorId: { type: String, required: true },
    type: { type: String, enum: ['PrivateEvent'], required: true },
    idOrganization: { type: String, required: true }
  },
  {
    timestamps: true,
    toObject: {
      transform: (doc, ret) => {
        ret.id = ret._id
        delete ret._id
      },
    },
    toJSON: {
      transform: (doc, ret) => {
        ret.id = ret._id
        delete ret._id
      },
    },
  }
)

export default mongoose.model<IAppointment>('Appointment', AppointmentSchema)
