// Веб-воркер для обработки аудио и распознавания речи
// Изолирует тяжёлые операции от основного потока UI

let transcriber = null;
let audioContext = null;
let cancelled = false;

// Импорт библиотеки (динамический импорт)
async function loadTransformers() {
    try {
        // Используем CDN для загрузки библиотеки
        const module = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm');
        return module;
    } catch (error) {
        throw new Error(`Не удалось загрузить transformers.js: ${error.message}`);
    }
}

// Инициализация модели
async function initModel() {
    postMessage({ type: 'progress', data: { step: 'model', status: 'active', message: 'Загрузка из CDN...' } });

    try {
        const { pipeline } = await loadTransformers();

        transcriber = await pipeline(
            'automatic-speech-recognition',
            'Xenova/whisper-tiny',
            {
                cache_dir: undefined,
                progress_callback: (data) => {
                    if (cancelled) throw new Error('Cancelled');

                    if (data.status === 'downloading') {
                        const pct = ((data.loaded / data.total) * 100).toFixed(1);
                        const size = (data.total / 1024 / 1024).toFixed(1);
                        postMessage({
                            type: 'progress',
                            data: {
                                step: 'model',
                                status: 'active',
                                message: `Загружено: ${pct}% из ${size} МБ`
                            }
                        });
                    }
                }
            }
        );

        postMessage({
            type: 'progress',
            data: { step: 'model', status: 'completed', message: 'Модель загружена и закэширована' }
        });

        return transcriber;
    } catch (error) {
        if (error.message === 'Cancelled') return null;
        throw error;
    }
}

// Декодирование аудио
async function decodeAudio(arrayBuffer) {
    postMessage({ type: 'progress', data: { step: 'decode', status: 'active', message: 'Декодирование...' } });

    try {
        if (!audioContext) {
            audioContext = new (self.OfflineAudioContext || self.webkitOfflineAudioContext)(1, 44100, 44100);
        }

        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        postMessage({
            type: 'progress',
            data: {
                step: 'decode',
                status: 'completed',
                message: `${audioBuffer.numberOfChannels} канал(а), ${audioBuffer.sampleRate} Гц, ${audioBuffer.duration.toFixed(1)} сек`
            }
        });

        return audioBuffer;
    } catch (error) {
        throw new Error(`Ошибка декодирования аудио: ${error.message}`);
    }
}

// Распознавание речи (без ресэмплинга!)
async function transcribeAudio(audioBuffer) {
    postMessage({ type: 'progress', data: { step: 'transcribe', status: 'active', message: 'Распознавание...' } });

    try {
        // Берём первый канал (моно)
        const audioData = audioBuffer.getChannelData(0);

        // Передаём оригинальную частоту дискретизации
        const result = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: 'ru',
            task: 'transcribe',
            sampling_rate: audioBuffer.sampleRate // КЛЮЧЕВОЙ ПАРАМЕТР!
        });

        postMessage({
            type: 'progress',
            data: { step: 'transcribe', status: 'completed', message: 'Текст распознан' }
        });

        return result.text;
    } catch (error) {
        if (error.message === 'Cancelled') return null;
        throw new Error(`Ошибка распознавания: ${error.message}`);
    }
}

// Обработка файла
async function processFile(fileData) {
    try {
        cancelled = false;

        // Инициализация модели
        const model = await initModel();
        if (cancelled || !model) return;

        // Декодирование аудио
        const audioBuffer = await decodeAudio(fileData.arrayBuffer);
        if (cancelled) return;

        // Распознавание
        const text = await transcribeAudio(audioBuffer);
        if (cancelled || !text) return;

        // Отправка результата
        postMessage({
            type: 'result',
            data: {
                text: text,
                audioBuffer: {
                    duration: audioBuffer.duration,
                    sampleRate: audioBuffer.sampleRate,
                    numberOfChannels: audioBuffer.numberOfChannels
                },
                file: {
                    name: fileData.name,
                    size: fileData.size
                }
            }
        });

    } catch (error) {
        postMessage({ type: 'error', data: error.message });
    }
}

// Обработка URL
async function processUrl(url) {
    try {
        cancelled = false;

        postMessage({ type: 'progress', data: { step: 'decode', status: 'active', message: 'Загрузка аудио...' } });

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Не удалось загрузить файл: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;

        await processFile({
            name: url.split('/').pop() || 'audio',
            size: arrayBuffer.byteLength,
            arrayBuffer: arrayBuffer
        });

    } catch (error) {
        postMessage({ type: 'error', data: error.message });
    }
}

// Обработчик сообщений от основного потока
self.onmessage = async (event) => {
    const { type, file, url } = event.data;

    switch (type) {
        case 'transcribe':
            await processFile(file);
            break;
        case 'transcribeUrl':
            await processUrl(url);
            break;
        case 'cancel':
            cancelled = true;
            postMessage({ type: 'log', data: 'Обработка отменена' });
            break;
        case 'ping':
            postMessage({ type: 'pong' });
            break;
    }
};

// Обработка ошибок воркера
self.onerror = (error) => {
    postMessage({ type: 'error', data: error.message });
    return true; // Предотвращает стандартное поведение
};