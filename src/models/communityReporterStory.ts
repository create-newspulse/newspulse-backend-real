import mongoose, { Schema, Document, Model } from 'mongoose';

export type Priority = 'founder' | 'editor' | 'low';
export type AiRisk = 'low' | 'medium' | 'high' | 'flagged';
export type Status = 'pending' | 'approved' | 'rejected';
export type Source = 'community' | 'verified';

export interface CommunityReporterStoryDoc extends Document {
  headline: string;
  reporterName: string;
  email?: string;
  phone?: string;
  city?: string;
  district?: string;
  state?: string;
  country?: string;
  category?: string;
  priority: Priority;
  aiRisk: AiRisk;
  status: Status;
  source: Source;
  createdAt: Date;
  updatedAt: Date;
}

const CommunityReporterStorySchema = new Schema<CommunityReporterStoryDoc>(
  {
    headline: { type: String, required: true, trim: true },
    reporterName: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    city: { type: String, trim: true },
    district: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    category: { type: String, trim: true },
    priority: { type: String, enum: ['founder', 'editor', 'low'], default: 'low' },
    aiRisk: { type: String, enum: ['low', 'medium', 'high', 'flagged'], default: 'low' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    source: { type: String, enum: ['community', 'verified'], default: 'community' },
  },
  { timestamps: true }
);

export const CommunityReporterStory: Model<CommunityReporterStoryDoc> =
  mongoose.models.CommunityReporterStory || mongoose.model<CommunityReporterStoryDoc>('CommunityReporterStory', CommunityReporterStorySchema);
