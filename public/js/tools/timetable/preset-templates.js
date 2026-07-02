export const PRESET_TEMPLATES = {
    standard: {
        name: '标准作息',
        description: '适用于大部分中小学',
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
            { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 4, classMinutes: null, breakMinutes: null },
            { id: 'seg-2', label: '下午时段', startTime: '14:00', periodCount: 3, classMinutes: null, breakMinutes: null }
        ]
    },

    withMorningEvening: {
        name: '含早晚自习',
        description: '高中、初中寄宿制',
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
            { id: 'seg-1', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10 },
            { id: 'seg-2', label: '上午时段', startTime: '08:00', periodCount: 4, classMinutes: null, breakMinutes: null },
            { id: 'seg-3', label: '下午时段', startTime: '14:00', periodCount: 3, classMinutes: null, breakMinutes: null },
            { id: 'seg-4', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: null, breakMinutes: null }
        ]
    },

    elementary: {
        name: '小学作息',
        description: '课时较短,下午较少',
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
            { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 4, classMinutes: null, breakMinutes: null },
            { id: 'seg-2', label: '下午时段', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null }
        ]
    },

    juniorHigh: {
        name: '初中作息',
        description: '标准7-8节',
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
            { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 4, classMinutes: null, breakMinutes: null },
            { id: 'seg-2', label: '下午时段', startTime: '14:00', periodCount: 3, classMinutes: null, breakMinutes: null }
        ]
    },

    seniorHigh: {
        name: '高中作息',
        description: '含早晚自习',
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
            { id: 'seg-1', label: '早读', startTime: '07:30', periodCount: 1, classMinutes: 30, breakMinutes: 10 },
            { id: 'seg-2', label: '上午时段', startTime: '08:10', periodCount: 5, classMinutes: null, breakMinutes: null },
            { id: 'seg-3', label: '下午时段', startTime: '14:00', periodCount: 3, classMinutes: null, breakMinutes: null },
            { id: 'seg-4', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: null, breakMinutes: null }
        ]
    }
};
