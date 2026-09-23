import { Op } from 'sequelize';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import ChangeLog from '../models/ChangeLog.js';

/**
 * التحقق مما إذا كان الموظف نشطاً حالياً (ليس في إجازة وضمن ساعات وأيام عمله).
 */
export function isEmployeeActiveNow(employee) {
    if (!employee || employee.isOnLeave || !employee.is_active) return false;

    const now = new Date();
    
    // 1. تحقق من أيام العمل
    if (employee.workDays) {
        const daysOfWeek = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const currentDayArabic = daysOfWeek[now.getDay()];
        const allowedDays = employee.workDays.split(',').map(d => d.trim());
        if (!allowedDays.includes(currentDayArabic)) {
            return false;
        }
    }

    // 2. تحقق من ساعات العمل
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    const startTime = employee.workStartTime || '09:00';
    const endTime = employee.workEndTime || '17:00';

    if (startTime <= endTime) {
        return currentTimeStr >= startTime && currentTimeStr <= endTime;
    } else {
        return currentTimeStr >= startTime || currentTimeStr <= endTime;
    }
}

/**
 * تخصيص العميل تلقائياً لموظف مبيعات نشط (Round Robin) بناءً على الأقل عملاء.
 */
export async function assignCustomerToSales(customerId, botOwnerId, io = null) {
    try {
        const customer = await Customer.findByPk(customerId);
        if (!customer) {
            console.error(`[Assignment] Customer with ID ${customerId} not found.`);
            return null;
        }

        // 1. جلب كل الموظفين (Sales و Admin) التابعين للنظام
        const employees = await User.findAll({
            where: {
                role: { [Op.in]: ['sales', 'admin'] },
                is_active: true
            }
        });

        // 2. تصفية الموظفين النشطين حالياً
        const activeEmployees = employees.filter(isEmployeeActiveNow);

        if (activeEmployees.length === 0) {
            console.log(`⚠️ [Assignment] No active sales employees found for customer ID: ${customerId}`);
            return null;
        }

        // 3. حساب عدد العملاء النشطين (وليس الناجحين أو غير المهتمين) المخصصين لكل موظف حالياً
        const candidates = [];
        for (const emp of activeEmployees) {
            const activeCount = await Customer.count({
                where: {
                    assignedToUserId: emp.id,
                    status: {
                        [Op.notIn]: ['successful', 'not_interested']
                    }
                }
            });

            // 4. التحقق من عدم تجاوز الحد الأقصى للموظف (تم تعطيله ليكون مفتوحاً دائماً)
            candidates.push({
                employee: emp,
                activeCount
            });
        }

        if (candidates.length === 0) {
            console.log(`⚠️ [Assignment] All active employees are at maximum customer capacity.`);
            return null;
        }

        // 5. ترتيب المرشحين تصاعدياً حسب عدد العملاء الحاليين (Round Robin)
        candidates.sort((a, b) => a.activeCount - b.activeCount);
        const selectedEmp = candidates[0].employee;

        // 6. تخصيص العميل
        customer.assignedToUserId = selectedEmp.id;
        customer.assignedAt = new Date();
        customer.status = 'awaiting_sales'; // تحويل لحالة انتظار المبيعات
        await customer.save();

        // 7. تسجيل الإجراء في السجل
        try {
            await ChangeLog.create({
                action: 'customer_assigned',
                description: `قام البوت آلياً بتعيين العميل للموظف ${selectedEmp.fullName || selectedEmp.username}`,
                CustomerId: customer.id,
                UserId: botOwnerId
            });
        } catch (logErr) {
            console.error('Error creating ChangeLog for auto-assignment:', logErr);
        }

        // تسجيل إحصائيات التعيين في نظام الـ KPI تلقائياً
        try {
            const { recordAssignment } = await import('./kpiService.js');
            await recordAssignment(selectedEmp.id, customer.id);
        } catch (kpiErr) {
            console.error('Error recording KPI assignment in assignmentService:', kpiErr);
        }

        // إطلاق إشعار للموظف المسؤول عبر لوحة التحكم
        try {
            const { createNotification } = await import('./notificationService.js');
            await createNotification({
                type: 'customer_assigned',
                title: 'عميل جديد (توزيع تلقائي)',
                message: `تم تخصيص عميل جديد لك تلقائياً: "${customer.customerName || customer.phoneNumber}"`,
                targetUserId: selectedEmp.id,
                customerId: customer.id,
                ownerId: botOwnerId,
                io
            });
        } catch (notifErr) {
            console.error('Error creating notification in auto-assignment:', notifErr);
        }

        // إرسال إشعار لجروب الواتساب الخاص بالعمل
        try {
            const whatsappMsg = `📢 *تم تعيين عميل جديد تلقائياً!*\n\n👤 العميل: ${customer.customerName || 'عميل واتساب'}\n📞 الرقم: ${customer.phoneNumber}\n👨‍💼 الموظف المسؤول: ${selectedEmp.fullName || selectedEmp.username}\n🕐 وقت التعيين: ${new Date().toLocaleString('en-US', { hour12: true })}`;
            const { sendWhatsAppNotification } = await import('./notificationService.js');
            await sendWhatsAppNotification(botOwnerId, whatsappMsg);
        } catch (wsErr) {
            console.error('Error sending WhatsApp notification in auto-assignment:', wsErr);
        }

        console.log(`✅ [Assignment] Customer ${customer.customerName || customer.phoneNumber} assigned to ${selectedEmp.fullName} (Active customers count: ${candidates[0].activeCount})`);
        return selectedEmp;
    } catch (err) {
        console.error('Error in assignCustomerToSales service:', err);
        return null;
    }
}

/**
 * نقل عملاء موظف عند تفعيل إجازته للموظف البديل أو إعادة توزيعهم.
 */
export async function reassignOnLeave(userId) {
    try {
        const employee = await User.findByPk(userId);
        if (!employee) return;

        // جلب كل العملاء النشطين المخصصين للموظف الذي سيذهب لإجازة
        const activeCustomers = await Customer.findAll({
            where: {
                assignedToUserId: userId,
                status: {
                    [Op.notIn]: ['successful', 'not_interested']
                }
            }
        });

        if (activeCustomers.length === 0) return;

        console.log(`🔄 [Reassignment] Reassigning ${activeCustomers.length} active customers from ${employee.fullName}...`);

        // التحقق من وجود بديل ونشاطه
        let substitute = null;
        if (employee.substituteUserId) {
            const sub = await User.findByPk(employee.substituteUserId);
            if (sub && isEmployeeActiveNow(sub)) {
                substitute = sub;
            }
        }

        if (substitute) {
            // تخصيص كل عملاء الموظف للبديل
            for (const cust of activeCustomers) {
                cust.assignedToUserId = substitute.id;
                cust.assignedAt = new Date();
                await cust.save();
            }
            console.log(`✅ [Reassignment] Reassigned all ${activeCustomers.length} customers to substitute: ${substitute.fullName}`);
        } else {
            // في حالة عدم توفر بديل نشط، نعيد توزيع العملاء باستخدام Round Robin للآخرين
            console.log(`🔍 [Reassignment] No active substitute for ${employee.fullName}. Re-distributing customers...`);
            for (const cust of activeCustomers) {
                // إبعاد الموظف الحالي لضمان عدم إرجاع العميل له
                cust.assignedToUserId = null;
                await cust.save();
                
                const assigned = await assignCustomerToSales(cust.id, cust.UserId);
                if (!assigned) {
                    console.log(`⚠️ [Reassignment] Customer ID ${cust.id} remained unassigned.`);
                }
            }
        }
    } catch (err) {
        console.error('Error in reassignOnLeave service:', err);
    }
}
