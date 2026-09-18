-- The fresh schema includes fictional email addresses. Enable only controlled demo recipients.
UPDATE public.technicians SET active = false WHERE email LIKE '%@example.com';
