import mongoose, { Schema, Document } from 'mongoose'

export interface IDoctor extends Document {
  id: string,
  blocks: [
    {
      openHours: OpenHour,
      idOrganization: String
    }
  ]
}

export interface OpenHour {
  mon: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
  tue: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
  wed: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
  thu: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
  fri: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
  sat: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
  sun: { start: number; end: number, appointmentType: 'AV' | 'V' | 'A' }[]
}

const DoctorSchema: Schema = new Schema(
  {
    _id: String,
    id: { type: String, required: true },
    blocks: [
      {
        openHours: {
          mon: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
          tue: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
          wed: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
          thu: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
          fri: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
          sat: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
          sun: [{ start: Number, end: Number, appointmentType: { type: String, enum: ['AV', 'V', 'A'], required: true } }],
        },
        idOrganization: String
      }
    ]
  },
  { timestamps: true, _id: false }
)



DoctorSchema.index({ id: 1 })

export default mongoose.model<IDoctor>('Doctor', DoctorSchema)
