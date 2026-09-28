-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BlogStatus" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "BlogCategory" AS ENUM ('Krishna Katha', 'Vaishnava Songs and Prayers', 'Our Acharyas', 'Spiritual Knowledge', 'Sacred Festivals & Occasions', 'Spiritual News & Events', 'Spiritual Charity', 'Timeless Wisdom', 'Divine Poetics', 'Krishna Consciousness', 'Recipes', 'Pilgrimage', 'Other');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'donations_admin', 'blogs_admin', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('new', 'read', 'responded');

-- CreateEnum
CREATE TYPE "DonationStatus" AS ENUM ('pending', 'active', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "DonationSite" AS ENUM ('vizag', 'kakinada');

-- CreateEnum
CREATE TYPE "ManualPaymentMode" AS ENUM ('upi', 'bank', 'cash', 'cheque');

-- CreateEnum
CREATE TYPE "DccSyncStatus" AS ENUM ('pending', 'syncing', 'synced', 'failed');

-- CreateEnum
CREATE TYPE "CampaignerStatus" AS ENUM ('active', 'inactive', 'closed');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('upcoming', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "GalleryType" AS ENUM ('darshan', 'festival', 'seva', 'community', 'other');

-- CreateEnum
CREATE TYPE "GalleryStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "ImportantDateType" AS ENUM ('Ekadashi', 'Festival', 'Other');

-- CreateEnum
CREATE TYPE "TempleDevoteeStatus" AS ENUM ('active', 'hidden');

-- CreateEnum
CREATE TYPE "VolunteerCategory" AS ENUM ('festival', 'weekly', 'special', 'outreach');

-- CreateEnum
CREATE TYPE "VolunteerEventStatus" AS ENUM ('active', 'closed', 'completed');

-- CreateEnum
CREATE TYPE "VolunteerRegistrationStatus" AS ENUM ('pending', 'approved', 'rejected', 'completed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blogs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "coverImage" TEXT NOT NULL DEFAULT '',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" "BlogCategory" NOT NULL DEFAULT 'Spiritual Knowledge',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author" JSONB NOT NULL DEFAULT '{}',
    "status" "BlogStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "readTime" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "deletionRequested" BOOLEAN NOT NULL DEFAULT false,
    "deletionRequestedBy" TEXT,
    "deletionRequestedAt" TIMESTAMP(3),
    "metaTitle" TEXT NOT NULL DEFAULT '',
    "metaDescription" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "CampaignerStatus" NOT NULL DEFAULT 'active',
    "referredByDevotee" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temple_devotees" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dccEnrolledById" DOUBLE PRECISION,
    "status" "TempleDevoteeStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temple_devotees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_messages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT 'General Enquiry',
    "message" TEXT NOT NULL,
    "authorization" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContactStatus" NOT NULL DEFAULT 'new',
    "source" TEXT NOT NULL DEFAULT 'contact-page',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "festival_donations" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "donationOptions" JSONB NOT NULL DEFAULT '[]',
    "eventId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "festival_donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donations" (
    "id" TEXT NOT NULL,
    "donorName" TEXT NOT NULL,
    "donorEmail" TEXT,
    "donorMobile" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL DEFAULT 'General',
    "status" "DonationStatus" NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "sourcePage" TEXT,
    "site" "DonationSite" NOT NULL DEFAULT 'kakinada',
    "sevaName" TEXT,
    "legacySevaId" DOUBLE PRECISION,
    "paymentAccount" TEXT,
    "transactionId" TEXT,
    "festivalId" TEXT,
    "festivalSlug" TEXT,
    "campaignerSlug" TEXT,
    "dccEnrolledById" DOUBLE PRECISION,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "panNumber" TEXT,
    "certificate" BOOLEAN NOT NULL DEFAULT false,
    "sevakName" TEXT,
    "sevaDate" TEXT,
    "dob" TEXT,
    "wantPrasadam" BOOLEAN NOT NULL DEFAULT false,
    "prasadamAddress" JSONB NOT NULL DEFAULT '{}',
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "manualEntry" BOOLEAN NOT NULL DEFAULT false,
    "utrNumber" TEXT,
    "manualPaymentMode" "ManualPaymentMode",
    "manualEntryNote" TEXT,
    "manualEnteredBy" TEXT,
    "subscriptionId" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "lastPaymentDate" TIMESTAMP(3),
    "receiptNumber" TEXT,
    "receiptGeneratedAt" TIMESTAMP(3),
    "dccSyncStatus" "DccSyncStatus" NOT NULL DEFAULT 'pending',
    "lastReconcileCheckAt" TIMESTAMP(3),
    "dccSyncedAt" TIMESTAMP(3),
    "dccLastAttemptAt" TIMESTAMP(3),
    "dccSyncError" TEXT,
    "dccPayload" JSONB,
    "dccResponse" JSONB,
    "whatsappReceiptSentAt" TIMESTAMP(3),
    "whatsappReceiptError" TEXT,
    "whatsappMessageId" TEXT,
    "whatsappDeliveryStatus" TEXT,
    "whatsappDeliveredAt" TIMESTAMP(3),
    "whatsappPendingReminderSent" BOOLEAN NOT NULL DEFAULT false,
    "whatsappPendingReminderAttempts" INTEGER NOT NULL DEFAULT 0,
    "whatsappPendingReminderError" TEXT,
    "metaEventId" TEXT,
    "metaFbp" TEXT,
    "metaFbc" TEXT,
    "metaClientIp" TEXT,
    "metaUserAgent" TEXT,
    "metaPurchaseSentAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "account" TEXT NOT NULL DEFAULT 'default',
    "planId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation_pages" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'donations',
    "heroTitle" TEXT,
    "heroSubtitle" TEXT,
    "heroEyebrow" TEXT,
    "bannerImage" TEXT,
    "bannerMobileImage" TEXT,
    "trusteeBannerImage" TEXT,
    "annadaanImage" TEXT,
    "goSevaImage" TEXT,
    "annadaanTitle" TEXT,
    "annadaanDescription" TEXT,
    "goSevaTitle" TEXT,
    "goSevaDescription" TEXT,
    "donationOptions" JSONB NOT NULL DEFAULT '[]',
    "galleryImages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "impactItems" JSONB NOT NULL DEFAULT '[]',
    "bankDetails" JSONB NOT NULL DEFAULT '{}',
    "contact" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "donation_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "registrationForm" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT NOT NULL DEFAULT 'General',
    "status" "EventStatus" NOT NULL DEFAULT 'upcoming',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "attendance" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "galleries" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "images" TEXT[],
    "date" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "type" "GalleryType" NOT NULL DEFAULT 'darshan',
    "status" "GalleryStatus" NOT NULL DEFAULT 'active',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "galleries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hero_banners" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "desktopImage" TEXT NOT NULL,
    "mobileImage" TEXT NOT NULL,
    "linkUrl" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hero_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "important_dates" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "type" "ImportantDateType" NOT NULL DEFAULT 'Other',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "important_dates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "format" TEXT,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "bytes" DOUBLE PRECISION,
    "folder" TEXT NOT NULL DEFAULT 'media-library',
    "tags" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_contents" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'main',
    "hero" JSONB NOT NULL DEFAULT '{}',
    "about" JSONB NOT NULL DEFAULT '{}',
    "contact" JSONB NOT NULL DEFAULT '{}',
    "navbar" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "location" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "slots" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "filledSlots" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" "VolunteerCategory" NOT NULL DEFAULT 'festival',
    "requirements" TEXT NOT NULL DEFAULT '',
    "status" "VolunteerEventStatus" NOT NULL DEFAULT 'active',
    "formFields" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volunteer_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_registrations" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "responses" JSONB NOT NULL DEFAULT '{}',
    "status" "VolunteerRegistrationStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volunteer_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "blogs_slug_key" ON "blogs"("slug");

-- CreateIndex
CREATE INDEX "blogs_status_publishedAt_idx" ON "blogs"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "blogs_category_status_publishedAt_idx" ON "blogs"("category", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "blogs_deletionRequested_idx" ON "blogs"("deletionRequested");

-- CreateIndex
CREATE INDEX "blogs_featured_idx" ON "blogs"("featured");

-- CreateIndex
CREATE UNIQUE INDEX "campaigners_slug_key" ON "campaigners"("slug");

-- CreateIndex
CREATE INDEX "campaigners_status_idx" ON "campaigners"("status");

-- CreateIndex
CREATE INDEX "temple_devotees_status_idx" ON "temple_devotees"("status");

-- CreateIndex
CREATE INDEX "contact_messages_status_createdAt_idx" ON "contact_messages"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "festival_donations_slug_key" ON "festival_donations"("slug");

-- CreateIndex
CREATE INDEX "festival_donations_active_idx" ON "festival_donations"("active");

-- CreateIndex
CREATE INDEX "donations_date_idx" ON "donations"("date");

-- CreateIndex
CREATE INDEX "donations_status_idx" ON "donations"("status");

-- CreateIndex
CREATE INDEX "donations_site_idx" ON "donations"("site");

-- CreateIndex
CREATE INDEX "donations_razorpayOrderId_idx" ON "donations"("razorpayOrderId");

-- CreateIndex
CREATE INDEX "donations_donorMobile_idx" ON "donations"("donorMobile");

-- CreateIndex
CREATE INDEX "donations_utrNumber_idx" ON "donations"("utrNumber");

-- CreateIndex
CREATE INDEX "donations_campaignerSlug_idx" ON "donations"("campaignerSlug");

-- CreateIndex
CREATE INDEX "donations_festivalId_idx" ON "donations"("festivalId");

-- CreateIndex
CREATE INDEX "donations_dccSyncStatus_idx" ON "donations"("dccSyncStatus");

-- CreateIndex
CREATE INDEX "donations_whatsappMessageId_idx" ON "donations"("whatsappMessageId");

-- CreateIndex
CREATE INDEX "donations_whatsappPendingReminderSent_createdAt_idx" ON "donations"("whatsappPendingReminderSent", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "plan_amount_account_key" ON "plans"("amount", "account");

-- CreateIndex
CREATE UNIQUE INDEX "donation_pages_key_key" ON "donation_pages"("key");

-- CreateIndex
CREATE INDEX "events_status_date_idx" ON "events"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_token_key" ON "registrations"("token");

-- CreateIndex
CREATE INDEX "registrations_eventId_idx" ON "registrations"("eventId");

-- CreateIndex
CREATE INDEX "galleries_type_status_idx" ON "galleries"("type", "status");

-- CreateIndex
CREATE INDEX "hero_banners_active_sort_order_idx" ON "hero_banners"("active", "sort_order");

-- CreateIndex
CREATE INDEX "important_dates_date_idx" ON "important_dates"("date");

-- CreateIndex
CREATE INDEX "media_createdAt_idx" ON "media"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_contents_key_key" ON "site_contents"("key");

-- CreateIndex
CREATE INDEX "volunteer_events_status_date_idx" ON "volunteer_events"("status", "date");

-- CreateIndex
CREATE INDEX "volunteer_registrations_eventId_idx" ON "volunteer_registrations"("eventId");

-- CreateIndex
CREATE INDEX "volunteer_registrations_status_idx" ON "volunteer_registrations"("status");

-- AddForeignKey
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_deletionRequestedBy_fkey" FOREIGN KEY ("deletionRequestedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigners" ADD CONSTRAINT "campaigners_referredByDevotee_fkey" FOREIGN KEY ("referredByDevotee") REFERENCES "temple_devotees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigners" ADD CONSTRAINT "campaigners_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "festival_donations" ADD CONSTRAINT "festival_donations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "festival_donations" ADD CONSTRAINT "festival_donations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_festivalId_fkey" FOREIGN KEY ("festivalId") REFERENCES "festival_donations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_manualEnteredBy_fkey" FOREIGN KEY ("manualEnteredBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_pages" ADD CONSTRAINT "donation_pages_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "galleries" ADD CONSTRAINT "galleries_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hero_banners" ADD CONSTRAINT "hero_banners_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "important_dates" ADD CONSTRAINT "important_dates_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_contents" ADD CONSTRAINT "site_contents_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_events" ADD CONSTRAINT "volunteer_events_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_registrations" ADD CONSTRAINT "volunteer_registrations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "volunteer_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

