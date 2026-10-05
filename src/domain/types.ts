// 가구(household) 상태 모델: 아이·물건·리콜 대조·할 일·주문·알림의 타입 정의
import type { CategoryId } from './categories.js';

export const STAGES = ['newborn', 'rolling', 'sitting', 'crawling', 'cruising', 'walking', 'climbing'] as const;
export type Stage = (typeof STAGES)[number];

export type ItemSource = 'owned' | 'hand_me_down' | 'secondhand';
export type Confidence = 'confirmed' | 'likely' | 'possible';
export type RemedyStatus = 'open' | 'requested' | 'resolved';

export interface Child {
  id: string;
  nickname: string;
  birthMonth?: string; // YYYY-MM, never a full birth date
  observedStage?: Stage;
  observedAt?: string;
  lastAuditedStage?: Stage;
}

export interface Item {
  id: string;
  category: CategoryId;
  name: string;
  brand?: string;
  model?: string;
  room?: string;
  source: ItemSource;
  anchored?: boolean; // furniture and TVs
  corded?: boolean; // window coverings
  hasBumpers?: boolean; // cribs
  doNotUse?: boolean; // set when a recall says to stop using it
  addedAt: string;
  status: 'active' | 'removed';
}

export interface RecallMatch {
  id: string;
  itemId: string;
  recallNumber: string;
  confidence: Confidence;
  firstSeenAt: string;
  remedyStatus: RemedyStatus;
  remedyUpdatedAt?: string;
}

export interface Task {
  id: string;
  title: string;
  kind: 'hazard' | 'recall' | 'purchase';
  ruleId?: string;
  itemId?: string;
  recallNumber?: string;
  room?: string;
  dueAt?: string;
  status: 'open' | 'done';
  createdAt: string;
  completedAt?: string;
}

export interface OrderLine {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  token: string;
  lines: OrderLine[];
  total: number;
  status: 'prepared' | 'confirmed';
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
}

export interface Alert {
  id: string;
  kind: 'recall' | 'stage';
  title: string;
  spoken: string;
  createdAt: string;
  read: boolean;
  recallNumber?: string;
  itemId?: string;
}

export interface Household {
  id: string;
  rooms: string[];
  children: Child[];
  items: Item[];
  recallMatches: RecallMatch[];
  tasks: Task[];
  orders: Order[];
  alerts: Alert[];
  lastRecallCheckAt?: string;
  updatedAt: string;
}
