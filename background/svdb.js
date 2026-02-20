// db.js
const DB_NAME = 'SecureViewDB';
const DB_VERSION = 1;
const STORE_NAME = 'visits';

const openDB = () => {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = (event) => {
			const db = event.target.result;
			// Create an objectStore with an auto-incrementing primary key
			const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });

			// Create Indexes for fast querying later
			objectStore.createIndex('category', 'category', { unique: false });
			objectStore.createIndex('timestamp', 'timestamp', { unique: false });
			objectStore.createIndex('url', 'url', { unique: false });
		};

		request.onsuccess = (event) => resolve(event.target.result);
		
		request.onerror = (event) => reject('Database error: ' + event.target.error);
	});
};

const addVisit = async (visitData) => {
	const db = await openDB();
	const transaction = db.transaction([STORE_NAME], 'readwrite');
	const store = transaction.objectStore(STORE_NAME);
	store.add(visitData);
};

// function to get data by category
const getVisitsByCategory = async (category) => {
	const db = await openDB();
	return new Promise((resolve) => {
		const transaction = db.transaction([STORE_NAME], 'readonly');
		const store = transaction.objectStore(STORE_NAME);
		const index = store.index('category');
		const request = index.getAll(category); // Extremely fast lookup

		request.onsuccess = () => resolve(request.result);
	});
};