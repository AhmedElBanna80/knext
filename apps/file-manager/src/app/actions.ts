'use server';

import { getDbPool, getMinioClient } from '@knative-next/framework';
import { revalidatePath } from 'next/cache';

export async function uploadFile(formData: FormData) {
  const file = formData.get('file') as File;

  if (!file) {
    return { error: 'No file provided' };
  }

  try {
    const minio = getMinioClient();
    const bucketName = 'assets';

    // Ensure bucket exists
    const bucketExists = await minio.bucketExists(bucketName);
    if (!bucketExists) {
      await minio.makeBucket(bucketName, 'us-east-1');
    }

    // Upload file
    const buffer = Buffer.from(await file.arrayBuffer());
    await minio.putObject(bucketName, file.name, buffer, buffer.length);

    // Store metadata in DB
    const db = getDbPool();
    await db.query(
      'INSERT INTO files (name, size, uploaded_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
      [file.name, file.size],
    );

    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Upload error:', error);
    return { error: 'Failed to upload file' };
  }
}
