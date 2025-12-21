import FileList from '@/components/FileList';
import UploadForm from '@/components/UploadForm';
import { getMinioClient } from '@knative-next/framework';
import { Suspense } from 'react';

// Force dynamic rendering to avoid prerendering issues with external services
export const dynamic = 'force-dynamic';

async function getFiles() {
  try {
    const minio = getMinioClient();
    const bucketName = 'assets';

    const bucketExists = await minio.bucketExists(bucketName);
    if (!bucketExists) {
      return [];
    }

    const stream = minio.listObjects(bucketName, '', true);
    const files: any[] = [];

    for await (const obj of stream) {
      files.push(obj);
    }

    return files;
  } catch (error) {
    console.error('Error listing files:', error);
    return [];
  }
}

export default async function Home() {
  const files = await getFiles();

  return (
    <div className="p-8">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl border border-white/20 p-8">
          <h1 className="text-4xl font-bold text-white mb-2">File Manager</h1>
          <p className="text-purple-200 mb-8">Powered by Knative + Next.js</p>

          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <h2 className="text-2xl font-semibold text-white mb-4">Upload File</h2>
              <UploadForm />
            </div>

            <div>
              <h2 className="text-2xl font-semibold text-white mb-4">Your Files</h2>
              <Suspense fallback={<div className="text-white">Loading files...</div>}>
                <FileList files={files} />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
